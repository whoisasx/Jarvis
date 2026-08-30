import {logEvent} from './logger.js';
import type {AgentAction, BrainMessage, ScreenState} from './protocol.js';
import type {PhoneTransport} from './phoneTransport.js';
import type {ScreenObserver} from './screenObserver.js';
import {compactObservation} from './observation.js';
import type {WorldStateManager} from './worldState.js';
import type {ToolObservation} from './toolTypes.js';

interface PendingExecution {
  resolve: (value: {screen: ScreenState; result: string}) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  requireActionResult: boolean;
}

export class DeviceExecutor {
  private phone: PhoneTransport | null = null;
  private pending: PendingExecution | null = null;
  private lastScreen: ScreenState | null = null;
  private lastScreenAt = 0;

  constructor(
    private readonly screenObserver: ScreenObserver,
    private readonly worldState: WorldStateManager,
  ) {}

  attachPhone(phone: PhoneTransport): void {
    this.phone = phone;
    phone.onClose(() => {
      if (this.phone === phone) this.phone = null;
      this.failPending(new Error('Phone disconnected'));
    });
  }

  hasPhone(): boolean {
    return this.phone !== null && this.phone.isConnected();
  }

  handleScreenState(screen: ScreenState): boolean {
    this.lastScreen = screen;
    this.lastScreenAt = Date.now();
    if (!this.pending) return false;
    if (this.pending.requireActionResult && (screen.lastActionResult == null || screen.lastActionResult === '')) {
      return false;
    }
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve({screen, result: screen.lastActionResult ?? 'ok'});
    return true;
  }

  currentObservation(lastActionResult?: string | null): ToolObservation {
    const screen = this.lastScreen ?? undefined;
    return compactObservation({
      screen,
      model: screen ? this.screenObserver.observe(screen) : this.worldState.snapshot().screen,
      world: this.worldState.snapshot(),
      lastActionResult: lastActionResult ?? screen?.lastActionResult ?? null,
    });
  }

  async requestScreen(): Promise<{screen: ScreenState; observation: ToolObservation}> {
    try {
      const {screen, result} = await this.sendAndWait({type: 'request_screen_state', requestId: `screen-${Date.now()}`}, 8_000, false);
      return {screen, observation: this.observe({...screen, observationFresh: screen.observationFresh ?? true}, result)};
    } catch (error) {
      if (this.lastScreen && Date.now() - this.lastScreenAt < 25_000) {
        return {
          screen: {...this.lastScreen, observationFresh: false},
          observation: this.observe({...this.lastScreen, observationFresh: false}, this.lastScreen.lastActionResult ?? 'ok'),
        };
      }
      throw error;
    }
  }

  async executeAction(action: AgentAction, requestId?: string): Promise<{screen: ScreenState; result: string; observation: ToolObservation}> {
    const timeoutMs = action.action === 'open_app'
      ? 15_000
      : action.action === 'call'
        ? 12_000
        : action.action === 'wait'
          ? action.ms + 4_000
          : 10_000;
    const {screen, result} = await this.sendAndWait({type: 'action', requestId, ...action}, timeoutMs, true);
    return {screen, result, observation: this.observe(screen, result)};
  }

  private observe(screen: ScreenState, result: string): ToolObservation {
    return compactObservation({
      screen,
      model: this.screenObserver.observe(screen),
      world: this.worldState.snapshot(),
      lastActionResult: result,
    });
  }

  private async sendAndWait(message: BrainMessage, timeoutMs: number, requireActionResult = false): Promise<{screen: ScreenState; result: string}> {
    if (!this.hasPhone()) throw new Error('Phone is not connected');
    if (this.pending) throw new Error('Another capability is already executing');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for Android observation`));
      }, timeoutMs);
      this.pending = {resolve, reject, timer, requireActionResult};
      try {
        this.phone!.send(message);
        void logEvent({
          kind: 'gateway_dispatch',
          messageType: message.type,
          action: message.type === 'action' ? message.action : undefined,
        });
      } catch (error) {
        this.pending = null;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private failPending(error: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(error);
    this.pending = null;
  }
}
