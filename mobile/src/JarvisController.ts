import {NativeEventEmitter, NativeModules} from 'react-native';
// Current Phase 2.2 host: React Native's TypeScript runtime embeds the Brain.
// Future host swap: a service-owned JavaScript runtime can implement the same
// BrainRuntime + PhoneTransport + LlmRuntime adapter boundary without changing
// planner, agents, task manager, memory, or business logic.
// @ts-ignore generated from ../brain/src by `npm run build` in brain
import {BrainRuntime} from '../../brain/dist-cjs/runtime.js';
// @ts-ignore generated from ../brain/src by `npm run build` in brain
import {setLogSink} from '../../brain/dist-cjs/logger.js';
import {CursorCloudLlmRuntime} from './cursorCloud';
// @ts-ignore generated from ../brain/src by `npm run build` in brain
import {OpenAILlmRuntime} from '../../brain/dist-cjs/llmRuntime.js';
import {
  JarvisAccessibility,
  JarvisDevice,
  JarvisTelephony,
  type NodeTreeItem,
} from './native';
import {
  MediaPipeRuntime,
  MODEL_REGISTRY,
  modelManager,
  recommendModel,
  type ModelDefinition,
} from './localAiRuntime';
import {JARVIS_CONFIG} from './config';
import {getAllLlmSettings} from './secureStore';
import {errorStack, newFlowId, persistFlowTrace} from './flowLog';

type ConnectionListener = (status: string) => void;
type ScreenEvent = {nodeTreeJson: string; packageName: string};
type NotificationEvent = {packageName: string; title: string; text: string; timestamp: number};
type SmsEvent = {sender: string; body: string; timestamp: number};
type AndroidEvent = {
  eventType: string;
  source: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  timestamp: number;
  payload: Record<string, unknown>;
};
type DeviceObservationEvent = {
  kind: 'app_changed' | 'screen_changed' | 'screen_activity' | 'user_interaction';
  packageName: string;
  appLabel?: string;
  className?: string;
  eventType?: string;
  timestamp: number;
};

type Action =
  | {type: 'action'; action: 'tap'; x: number; y: number; status?: string; progress?: number}
  | {type: 'action'; action: 'type'; text: string; status?: string; progress?: number}
  | {type: 'action'; action: 'find_and_tap'; targetText: string; status?: string; progress?: number}
  | {type: 'action'; action: 'swipe'; x1: number; y1: number; x2: number; y2: number; status?: string; progress?: number}
  | {type: 'action'; action: 'open_app'; packageName: string; status?: string; progress?: number}
  | {type: 'action'; action: 'resolve_app'; appName: string; status?: string; progress?: number}
  | {type: 'action'; action: 'list_apps'; status?: string; progress?: number}
  | {type: 'action'; action: 'get_device_profile'; status?: string; progress?: number}
  | {type: 'action'; action: 'get_recent_calls'; limit: number; status?: string; progress?: number}
  | {type: 'action'; action: 'get_recent_sms'; limit: number; status?: string; progress?: number}
  | {type: 'action'; action: 'call'; number: string; status?: string; progress?: number}
  | {type: 'action'; action: 'end_call'; status?: string; progress?: number}
  | {type: 'action'; action: 'compose_message'; number: string; body?: string; status?: string; progress?: number}
  | {type: 'action'; action: 'send_sms'; number: string; body: string; status?: string; progress?: number}
  | {type: 'action'; action: 'find_and_click'; text?: string; contentDescription?: string; resourceId?: string; className?: string; editable?: boolean; clickable?: boolean; status?: string; progress?: number}
  | {type: 'action'; action: 'press_back'; status?: string; progress?: number}
  | {type: 'action'; action: 'resolve_chooser'; preferredPackage?: string; preferredLabel?: string; status?: string; progress?: number}
  | {type: 'action'; action: 'type_text'; text: string; elementId?: string; status?: string; progress?: number}
  | {type: 'action'; action: 'wait'; ms: number; status?: string; progress?: number}
  | {type: 'action'; action: 'task_complete'; summary: string; status?: string; progress?: number}
  | {type: 'action'; action: 'task_failed'; reason: string; status?: string; progress?: number}
  | {type: 'action'; action: 'find_element'; text?: string; contentDescription?: string; resourceId?: string; className?: string; editable?: boolean; clickable?: boolean; status?: string; progress?: number}
  | {type: 'action'; action: 'focus_element'; elementId: string; status?: string; progress?: number}
  | {type: 'action'; action: 'click_element'; elementId: string; status?: string; progress?: number}
  | {type: 'action'; action: 'press_key'; key: string; status?: string; progress?: number}
  | {type: 'action'; action: 'open_url'; url: string; status?: string; progress?: number};

type BrainMessage = Action | {type: 'request_screen_state'} | {type: 'task_status'; status: string; detail?: string};

interface PhoneTransport {
  isConnected(): boolean;
  send(message: BrainMessage): void;
  onClose(listener: () => void): void;
  close(): void;
}

export interface LogEntry {
  ts: number;
  kind: string;
  detail: string;
  data?: unknown;
}

type LogListener = (log: LogEntry[]) => void;

class MobileLocalLlmRuntime {
  readonly provider = 'android-local';
  readonly model = 'MediaPipe via native bridge';
  private runtime: MediaPipeRuntime | null = null;
  private loadedModelId: string | null = null;

  constructor(private readonly observe: (kind: string, detail: string, data?: unknown) => void) {}

  async generate(request: {system: string; prompt: string; maxTokens?: number; temperature?: number}): Promise<string> {
    const startedAt = Date.now();
    this.observe('llm_generate_start', 'Preparing local model request', {
      maxTokens: request.maxTokens ?? 512,
      temperature: request.temperature ?? 0.2,
      promptChars: request.prompt.length,
      systemChars: request.system.length,
      promptPreview: previewText(request.prompt, 900),
    });
    const runtime = await this.ensureRuntime();
    const prompt = buildLocalPlannerPrompt(request);
    const maxTokens = Math.min(request.maxTokens ?? 512, 96);
    this.observe('llm_generate_call', 'Calling MediaPipe local runtime', {
      loadedModelId: this.loadedModelId,
      fullPromptChars: prompt.length,
      adaptedPromptPreview: previewText(prompt, 1400),
      maxTokens,
    });
    let streamedText = '';
    try {
      this.observe('llm_stream_start', 'Streaming local model output', {loadedModelId: this.loadedModelId});
      for await (const chunk of runtime.stream({
        prompt,
        maxTokens,
        temperature: request.temperature ?? 0.2,
      })) {
        streamedText += chunk;
        this.observe('llm_stream_chunk', chunk, {
          chunk,
          text: previewText(streamedText, 5000),
          totalChars: streamedText.length,
          elapsedMs: Date.now() - startedAt,
        });
      }
      this.observe('llm_stream_done', `Local model streamed ${streamedText.length} chars in ${Date.now() - startedAt}ms`, {
        loadedModelId: this.loadedModelId,
        outputPreview: previewText(streamedText, 1200),
        elapsedMs: Date.now() - startedAt,
      });
      if (!streamedText.trim()) {
        this.observe('llm_stream_empty', 'Streaming completed without text, falling back to blocking generate', {
          loadedModelId: this.loadedModelId,
          elapsedMs: Date.now() - startedAt,
        });
        const result = await runtime.generate({
          prompt,
          maxTokens,
          temperature: request.temperature ?? 0.2,
        });
        this.observe('llm_generate_result', `Local model returned ${result.text.length} chars after empty stream fallback`, {
          loadedModelId: this.loadedModelId,
          outputPreview: previewText(result.text, 1200),
          elapsedMs: Date.now() - startedAt,
        });
        return result.text;
      }
      return streamedText;
    } catch (error) {
      this.observe('llm_stream_fallback', `Streaming failed, falling back to blocking generate: ${errorMessage(error)}`);
      const result = await runtime.generate({
        prompt,
        maxTokens,
        temperature: request.temperature ?? 0.2,
      });
      this.observe('llm_generate_result', `Local model returned ${result.text.length} chars in ${Date.now() - startedAt}ms`, {
        loadedModelId: this.loadedModelId,
        outputPreview: previewText(result.text, 1200),
        elapsedMs: Date.now() - startedAt,
      });
      return result.text;
    }
  }

  private async ensureRuntime(): Promise<MediaPipeRuntime> {
    if (!this.runtime) {
      this.observe('runtime_initialize_start', 'Initializing MediaPipe runtime');
      const profile = await JarvisDevice.getDeviceProfile();
      this.runtime = new MediaPipeRuntime();
      await this.runtime.initialize(profile);
      this.observe('runtime_initialize_done', 'MediaPipe runtime initialized', {
        manufacturer: profile.manufacturer,
        model: profile.model,
        ramMB: profile.ramMB,
        cpuCores: profile.cpuCores,
        abi: profile.abi,
      });
    }

    const model = await this.pickModel();
    if (this.loadedModelId !== model.id || !(await this.runtime.isLoaded())) {
      this.observe('model_load_start', `Loading ${model.displayName}`, {
        modelId: model.id,
        format: model.format,
        installedSizeGB: model.installedSizeGB,
      });
      await this.runtime.loadModel(model);
      this.loadedModelId = model.id;
      this.observe('model_load_done', `Loaded ${model.displayName}`, {modelId: model.id});
    }
    return this.runtime;
  }

  private async pickModel(): Promise<ModelDefinition> {
    const installedModels = await modelManager.listInstalled();
    const activeModelId = installedModels.find(item => item.active)?.modelId ?? null;
    const activeModel = activeModelId ? MODEL_REGISTRY.find(item => item.id === activeModelId) : null;
    if (activeModel) {
      this.observe('model_select', `Using active model ${activeModel.displayName}`, {modelId: activeModel.id});
      return activeModel;
    }

    const profile = await JarvisDevice.getDeviceProfile();
    const recommended = recommendModel(profile).model;
    this.observe('model_select', `Using recommended model ${recommended.displayName}`, {modelId: recommended.id});
    return recommended;
  }
}

class InAppPhoneTransport implements PhoneTransport {
  private closed = false;
  private closeListeners = new Set<() => void>();

  constructor(private readonly dispatch: (message: BrainMessage) => Promise<void>) {}

  isConnected(): boolean {
    return !this.closed;
  }

  send(message: BrainMessage): void {
    if (this.closed) return;
    this.dispatch(message).catch(() => undefined);
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }
}

class Controller {
  private brain: InstanceType<typeof BrainRuntime> | null = null;
  private transport: InAppPhoneTransport | null = null;
  private stopped = true;
  private listenersInstalled = false;
  private latestScreen: ScreenEvent = {nodeTreeJson: '[]', packageName: ''};
  private statusListeners = new Set<ConnectionListener>();
  private logListeners = new Set<LogListener>();
  private currentStatus = 'Not started';
  private actionLog: LogEntry[] = [];
  private flowId = '';
  private taskId = '';

  subscribe(listener: ConnectionListener): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  subscribeLog(listener: LogListener): () => void {
    this.logListeners.add(listener);
    listener(this.actionLog);
    return () => this.logListeners.delete(listener);
  }

  getNodeTree(): string {
    return this.latestScreen.nodeTreeJson;
  }

  async start(): Promise<void> {
    this.flowId = this.flowId || newFlowId('boot');
    this.trace('controller_start', 'start', 'Starting embedded or laptop runtime');
    if (!this.stopped && (this.brain || !isEmbeddedBrainMode())) return;
    this.stopped = false;
    this.installNativeListeners();
    if (!isEmbeddedBrainMode()) {
      this.transport?.close();
      this.transport = null;
      this.brain?.stop();
      this.brain = null;
      this.pushLog('native_service_start', `Starting Android foreground service for ${JARVIS_CONFIG.brainWebSocketUrl}`);
      await JarvisDevice.startForegroundService(JARVIS_CONFIG.brainWebSocketUrl, JARVIS_CONFIG.phoneAuthToken);
      this.setStatus('Connected to laptop Brain');
      this.trace('controller_start', 'success', 'Laptop Brain service started');
      return;
    }

    setLogSink((event: Record<string, unknown>) => {
      const kind = typeof event.kind === 'string' ? event.kind : 'brain_event';
      this.pushLog(`brain:${kind}`, summarizeBrainEvent(event), event);
    });
    this.pushLog('runtime_start', 'Starting embedded Brain runtime');

    const llm = await this.createEmbeddedLlm();
    this.brain = new BrainRuntime({llm});
    this.transport = new InAppPhoneTransport(message => this.onBrainMessage(message));
    this.brain.start(this.transport);

    this.pushLog('native_service_start', 'Starting Android foreground service in local mode');
    await JarvisDevice.startForegroundService('local://embedded-brain', '');
    this.setStatus(
      llm.provider === 'openai' ? `OpenAI LLM ready (${llm.model})`
      : llm.provider === 'cursor' ? `Cursor cloud LLM ready (${llm.model})`
      : 'Embedded brain running on phone'
    );
    await JarvisAccessibility.overlayConnection(this.currentStatus).catch(() => undefined);
    this.trace('controller_start', 'success', `Embedded runtime ready via ${llm.provider}/${llm.model}`);
    await this.refreshAndSend(null);
  }

  private async createEmbeddedLlm(): Promise<MobileLocalLlmRuntime | InstanceType<typeof CursorCloudLlmRuntime> | InstanceType<typeof OpenAILlmRuntime>> {
    const observe = (kind: string, detail: string, data?: unknown) => {
      this.pushLog(kind, detail, data);
      if (kind === 'llm_generate_start' || kind === 'cursor_run_poll' || kind === 'cursor_agent_created') {
        JarvisAccessibility.overlayConnection(detail).catch(() => undefined);
      }
      if (kind.startsWith('llm_') || kind.startsWith('cursor_')) {
        this.trace(kind, kind.includes('fail') || kind.includes('error') ? 'fail' : 'start', detail);
      }
    };
    const {provider, cursor, openai} = await getAllLlmSettings();
    this.pushLog('llm_select', `Selected LLM provider: ${provider}`);
    if (provider === 'openai' && openai.apiKey) {
      this.pushLog('llm_select', `Using OpenAI LLM ${openai.modelId}`);
      return new OpenAILlmRuntime(openai.apiKey, openai.modelId);
    }
    if (provider === 'cursor' && cursor.apiKey) {
      this.pushLog('llm_select', `Using Cursor cloud LLM ${cursor.modelId}`);
      return new CursorCloudLlmRuntime({
        apiKey: cursor.apiKey,
        modelId: cursor.modelId,
        onEvent: observe,
      });
    }
    this.pushLog('llm_select', 'Using on-device MediaPipe runtime');
    return new MobileLocalLlmRuntime(observe);
  }

  stop(): void {
    this.stopped = true;
    this.transport?.close();
    this.transport = null;
    this.brain?.stop();
    this.brain = null;
    JarvisDevice.stopForegroundService().catch(() => undefined);
    this.setStatus('Stopped');
  }

  async restart(): Promise<void> {
    this.stop();
    await this.start();
  }

  async submitTask(instruction: string): Promise<string> {
    this.flowId = newFlowId('task');
    this.trace('ui_submit', 'start', instruction);
    if (this.stopped || (!this.brain && isEmbeddedBrainMode())) await this.start();
    if (!isEmbeddedBrainMode()) {
      this.pushLog('task_submit_start', instruction);
      const taskId = await submitTaskToLaptopBrain(instruction);
      this.taskId = taskId;
      this.pushLog('task_submit_done', `Accepted ${taskId}`, {taskId, instruction, mode: 'laptop'});
      this.trace('ui_submit', 'success', `Accepted ${taskId}`);
      return taskId;
    }
    if (!this.brain) throw new Error('Embedded brain did not start.');
    this.pushLog('task_submit_start', instruction);
    await JarvisAccessibility.overlayTaskStarted(instruction).catch(() => undefined);
    const taskId = await this.brain.submitTask(instruction);
    this.taskId = taskId;
    this.pushLog('task_submit_done', `Accepted ${taskId}`, {taskId, instruction});
    this.trace('ui_submit', 'success', `Accepted ${taskId}`);
    await this.refreshAndSend(null);
    return taskId;
  }

  getStatus(): {running: boolean; phoneConnected: boolean; llmProvider: string; llmModel: string} | null {
    if (!isEmbeddedBrainMode()) {
      return {
        running: !this.stopped,
        phoneConnected: !this.stopped,
        llmProvider: 'laptop-brain',
        llmModel: 'Gemini/Anthropic from brain/.env',
      };
    }
    return this.brain?.getStatus() ?? null;
  }

  private installNativeListeners(): void {
    if (this.listenersInstalled) return;
    this.listenersInstalled = true;
    const events = new NativeEventEmitter(NativeModules.JarvisDevice);
    events.addListener('screen_state', (event: ScreenEvent) => {
      this.latestScreen = event;
      this.pushLog('native_screen_state', event.packageName || 'Screen state received', {
        packageName: event.packageName,
        nodeTreeChars: event.nodeTreeJson.length,
      });
      this.sendScreenState(null);
    });
    events.addListener('notification', (event: NotificationEvent) => {
      this.pushLog('native_notification', `${event.packageName}: ${event.title}`, event);
      this.receivePhoneMessage({type: 'notification', ...event});
    });
    events.addListener('sms_received', (event: SmsEvent) => {
      this.pushLog('native_sms', `SMS from ${event.sender}`, {...event, body: previewText(event.body, 160)});
      this.receivePhoneMessage({type: 'sms_received', ...event});
    });
    events.addListener('android_event', (event: AndroidEvent) => {
      this.pushLog('native_event', `${event.eventType} from ${event.source}`, event);
      this.receivePhoneMessage({type: 'android_event', ...event});
    });
    events.addListener('device_observation', (event: DeviceObservationEvent) => {
      this.pushLog('native_observation', `${event.kind}: ${event.appLabel || event.packageName}`, event);
      this.receivePhoneMessage({
        type: 'device_observation',
        kind: event.kind,
        packageName: event.packageName,
        appLabel: event.appLabel ?? '',
        className: event.className ?? '',
        eventType: event.eventType ?? '',
        timestamp: event.timestamp,
      });
    });
    events.addListener('jarvis_error', (event: {message: string}) => {
      this.pushLog('native_error', event.message, event);
      this.setStatus(`Native error: ${event.message}`);
    });
    events.addListener('connection_status', (event: {status: string}) => {
      this.pushLog('native_status', event.status, event);
      this.setStatus(event.status);
    });
  }

  private async receivePhoneMessage(message: object): Promise<void> {
    if (!this.brain || this.stopped) return;
    try {
      this.pushLog('brain_receive_phone_message', messageType(message), compactMessage(message));
      await this.brain.receivePhoneMessage(message);
    } catch (error) {
      this.pushLog('brain_error', errorMessage(error), {message});
    }
  }

  private async onBrainMessage(message: BrainMessage): Promise<void> {
    try {
      this.pushLog('brain_to_phone', message.type === 'action' ? `action:${message.action}` : message.type, message);
      if (message.type === 'request_screen_state') {
        await this.refreshAndSend(null);
      } else if (message.type === 'task_status') {
        const status = message.detail ? `${message.status}: ${message.detail}` : message.status;
        this.setStatus(status);
        this.pushLog('task_status', status);
        this.trace('task_status', 'start', status);
        if (message.status === 'started' && message.detail) {
          await JarvisAccessibility.overlayTaskStarted(message.detail).catch(() => undefined);
        } else {
          await JarvisAccessibility.overlayConnection(status).catch(() => undefined);
        }
      } else if (message.type === 'action') {
        if (message.status) this.setStatus(message.status);
        this.pushLog('action', `${message.action}${message.progress == null ? '' : ` (${message.progress}%)`}`);
        this.trace('parse_action', 'success', message.action);
        await this.execute(message);
      }
    } catch (error) {
      this.trace('brain_message', 'fail', errorMessage(error), error);
      this.setStatus(`Protocol error: ${errorMessage(error)}`);
    }
  }

  private async execute(action: Action): Promise<void> {
    if (action.action === 'task_complete') {
      this.setStatus(`Complete: ${action.summary}`);
      this.pushLog('complete', action.summary, action);
      this.trace('native_execute', 'success', action.summary);
      await JarvisAccessibility.overlayFinished(action.summary, true).catch(() => undefined);
      return;
    }
    if (action.action === 'task_failed') {
      this.setStatus(`Failed: ${action.reason}`);
      this.pushLog('failed', action.reason, action);
      this.trace('native_execute', 'fail', action.reason);
      await JarvisAccessibility.overlayFinished(action.reason, false).catch(() => undefined);
      return;
    }

    let result = 'success';
    try {
      this.pushLog('native_action_start', action.action, action);
      this.trace('native_execute', 'start', action.action);
      await JarvisAccessibility.overlayAction(action.action, action.status ?? '', action.progress ?? -1).catch(() => undefined);
      switch (action.action) {
        case 'tap':
          await JarvisAccessibility.tap(action.x, action.y);
          break;
        case 'type':
          // Check if there's a focused editable field
          const typeNodeTree = JSON.parse(this.latestScreen.nodeTreeJson) as NodeTreeItem[];
          const focusedEditable = typeNodeTree.find(node => node.editable && node.focused);
          if (!focusedEditable) {
            result = 'failed: INPUT_NOT_FOCUSED - No editable element is focused';
            break;
          }
          await JarvisAccessibility.type(action.text);
          break;
        case 'find_and_tap':
          await JarvisAccessibility.findAndTap(action.targetText);
          break;
        case 'swipe':
          await JarvisAccessibility.swipe(action.x1, action.y1, action.x2, action.y2);
          break;
        case 'open_app':
          await JarvisDevice.openApp(action.packageName);
          break;
        case 'resolve_app':
          result = JSON.stringify(await resolveApp(action.appName, this.latestScreen.nodeTreeJson));
          break;
        case 'list_apps':
          result = JSON.stringify(await JarvisDevice.listApps());
          break;
        case 'get_device_profile':
          result = JSON.stringify(await JarvisDevice.getDeviceProfile());
          break;
        case 'get_recent_calls':
          result = JSON.stringify(await JarvisTelephony.getRecentCalls(action.limit));
          break;
        case 'get_recent_sms':
          result = JSON.stringify(await JarvisTelephony.getRecentSms(action.limit));
          break;
        case 'call':
          await JarvisTelephony.call(action.number);
          break;
        case 'type_text':
          await JarvisAccessibility.type_text(action.text, action.elementId);
          break;
        case 'find_and_click':
          result = await JarvisAccessibility.find_and_click(action);
          break;
        case 'press_back':
          result = JSON.stringify(await JarvisAccessibility.press_back());
          break;
        case 'end_call':
          result = JSON.stringify(await JarvisAccessibility.find_and_click({text: 'End call'}));
          break;
        case 'compose_message':
        case 'send_sms':
        case 'resolve_chooser':
          result = 'failed: Use laptop Brain / foreground service for this action';
          break;
        case 'wait':
          await delay(action.ms);
          break;
        case 'find_element':
          result = JSON.stringify(await this.findElement(action));
          break;
        case 'focus_element':
          result = JSON.stringify(await this.focusElement(action.elementId));
          break;
        case 'click_element':
          result = JSON.stringify(await this.clickElement(action.elementId));
          break;
        case 'press_key':
          result = JSON.stringify(await this.pressKey(action.key));
          break;
        case 'open_url':
          await JarvisAccessibility.openUrl(action.url);
          break;
      }
    } catch (error) {
      result = `failed: ${errorMessage(error)}`;
      this.trace('native_execute', 'fail', result, error);
    }
    if (!result.startsWith('failed:')) this.trace('native_execute', 'success', `${action.action}: ${previewText(result, 180)}`);
    this.pushLog('native_action_result', `${action.action}: ${previewText(result, 260)}`, {action, result});
    await delay(450);
    await this.refreshAndSend(result);
  }

  private async findElement(action: {text?: string; contentDescription?: string; resourceId?: string; className?: string; editable?: boolean; clickable?: boolean}): Promise<{success: boolean; elements: Array<{id: string; label: string; className: string; resourceId: string; contentDescription: string; focusable: boolean; focused: boolean; enabled: boolean; bounds: [number, number, number, number]; packageName: string; editable: boolean; clickable: boolean}>}> {
    try {
      const nodeTree = JSON.parse(this.latestScreen.nodeTreeJson) as NodeTreeItem[];
      const elements = nodeTree
        .filter(node => {
          if (action.text && !node.text?.includes(action.text)) return false;
          if (action.contentDescription && !node.contentDescription?.includes(action.contentDescription)) return false;
          if (action.resourceId && !node.resourceId?.includes(action.resourceId)) return false;
          if (action.className && !node.className?.includes(action.className)) return false;
          if (action.editable !== undefined && node.editable !== action.editable) return false;
          if (action.clickable !== undefined && node.clickable !== action.clickable) return false;
          return true;
        })
        .map((node, index) => ({
          id: `${node.packageName}:${index}:${node.bounds.join(',')}`,
          label: node.text || node.contentDescription || '',
          className: node.className,
          resourceId: node.resourceId || '',
          contentDescription: node.contentDescription || '',
          focusable: node.focusable ?? false,
          focused: node.focused ?? false,
          enabled: node.enabled ?? true,
          bounds: node.bounds,
          packageName: node.packageName || '',
          editable: node.editable,
          clickable: node.clickable,
        }));
      return {success: true, elements};
    } catch (error) {
      return {success: false, elements: []};
    }
  }

  private async focusElement(elementId: string): Promise<{success: boolean; message: string}> {
    try {
      // Use the accessibility service to focus the element by its identifier
      // The native module would need to support this
      // For now, we'll try to find the element and tap its center as fallback
      const nodeTree = JSON.parse(this.latestScreen.nodeTreeJson) as NodeTreeItem[];
      const element = nodeTree.find((node, index) => `${node.packageName}:${index}:${node.bounds.join(',')}` === elementId);
      if (!element) {
        return {success: false, message: `Element not found: ${elementId}`};
      }
      // Use findAndTap as a fallback to focus
      const targetText = element.text || element.contentDescription || '';
      if (targetText) {
        await JarvisAccessibility.findAndTap(targetText);
      } else {
        // Tap center of bounds
        const [x1, y1, x2, y2] = element.bounds;
        await JarvisAccessibility.tap(Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
      }
      return {success: true, message: `Focused element: ${elementId}`};
    } catch (error) {
      return {success: false, message: `Failed to focus element: ${errorMessage(error)}`};
    }
  }

  private async clickElement(elementId: string): Promise<{success: boolean; message: string}> {
    try {
      const nodeTree = JSON.parse(this.latestScreen.nodeTreeJson) as NodeTreeItem[];
      const element = nodeTree.find((node, index) => `${node.packageName}:${index}:${node.bounds.join(',')}` === elementId);
      if (!element) {
        return {success: false, message: `Element not found: ${elementId}`};
      }
      // Use findAndTap as a fallback to click
      const targetText = element.text || element.contentDescription || '';
      if (targetText) {
        await JarvisAccessibility.findAndTap(targetText);
      } else {
        const [x1, y1, x2, y2] = element.bounds;
        await JarvisAccessibility.tap(Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
      }
      return {success: true, message: `Clicked element: ${elementId}`};
    } catch (error) {
      return {success: false, message: `Failed to click element: ${errorMessage(error)}`};
    }
  }

private async pressKey(key: string): Promise<{success: boolean; message: string}> {
      try {
        // The native module would need to support key events
        // For now, if it's 'enter', we can try to simulate it
        // This is a placeholder - the native module should handle this properly
        return {success: false, message: `Key press not yet implemented: ${key}`};
      } catch (error) {
        return {success: false, message: `Failed to press key: ${errorMessage(error)}`};
      }
    }

  private async refreshAndSend(lastActionResult: string | null): Promise<void> {
    try {
      this.pushLog('screen_capture_start', 'Reading Accessibility node tree');
      this.trace('screen_capture', 'start', 'Reading Accessibility node tree');
      this.latestScreen = {
        ...this.latestScreen,
        nodeTreeJson: await JarvisAccessibility.getCurrentNodeTree(),
      };
      this.pushLog('screen_capture_done', `${this.latestScreen.nodeTreeJson.length} chars`, {
        packageName: this.latestScreen.packageName,
        nodeTreeChars: this.latestScreen.nodeTreeJson.length,
      });
      this.trace('screen_capture', 'success', `${this.latestScreen.nodeTreeJson.length} chars`);
    } catch (error) {
      this.pushLog('screen_capture_failed', 'Accessibility node tree unavailable');
      this.trace('screen_capture', 'fail', 'Accessibility node tree unavailable', error);
    }
    this.sendScreenState(lastActionResult);
  }

  private sendScreenState(lastActionResult: string | null): void {
    let nodeTree: NodeTreeItem[] = [];
    try {
      nodeTree = JSON.parse(this.latestScreen.nodeTreeJson) as NodeTreeItem[];
    } catch {
      // Keep the protocol valid even if a vendor accessibility node contains malformed data.
    }
    this.pushLog('screen_state_to_brain', `${nodeTree.length} nodes from ${this.latestScreen.packageName || 'unknown package'}`, {
      packageName: this.latestScreen.packageName,
      nodeCount: nodeTree.length,
      lastActionResult,
    });
    this.receivePhoneMessage({
      type: 'screen_state',
      nodeTree,
      packageName: this.latestScreen.packageName,
      lastActionResult,
    });
  }

  private pushLog(kind: string, detail: string, data?: unknown): void {
    this.actionLog = [{ts: Date.now(), kind, detail, data}, ...this.actionLog].slice(0, 160);
    for (const listener of this.logListeners) listener(this.actionLog);
    if (kind.includes('error') || kind.includes('fail') || kind.startsWith('brain:') || kind.startsWith('llm_') || kind.startsWith('native_')) {
      persistFlowTrace({
        ts: Date.now(),
        flowId: this.flowId,
        taskId: this.taskId,
        step: kind,
        phase: kind.includes('fail') || kind.includes('error') ? 'fail' : 'start',
        detail,
      });
    }
  }

  private trace(step: string, phase: 'start' | 'success' | 'fail', detail: string, error?: unknown): void {
    persistFlowTrace({
      ts: Date.now(),
      flowId: this.flowId,
      taskId: this.taskId,
      step,
      phase,
      detail,
      error: error ? errorMessage(error) : undefined,
      stack: error ? errorStack(error) : undefined,
    });
  }

  private setStatus(status: string): void {
    this.currentStatus = status;
    this.pushLog('status', status);
    for (const listener of this.statusListeners) listener(status);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEmbeddedBrainMode(): boolean {
  return JARVIS_CONFIG.brainWebSocketUrl.startsWith('local://');
}

function laptopTaskUrl(): string {
  return JARVIS_CONFIG.brainWebSocketUrl
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:')
    .replace(/\/phone(?:\?.*)?$/, '/task');
}

async function submitTaskToLaptopBrain(instruction: string): Promise<string> {
  const response = await fetch(laptopTaskUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${JARVIS_CONFIG.phoneAuthToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({instruction}),
  });
  const body = await response.json() as {taskId?: unknown; error?: unknown};
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Task request failed with HTTP ${response.status}`);
  if (typeof body.taskId !== 'string') throw new Error('Brain did not return a task id.');
  return body.taskId;
}

function previewText(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

type InstalledApp = {label: string; packageName: string};
type AppResolution = {
  query: string;
  bestMatch: InstalledApp | null;
  matches: Array<InstalledApp & {score: number; source: string}>;
  visibleLauncherLabels: string[];
};

async function resolveApp(query: string, nodeTreeJson: string): Promise<AppResolution> {
  const apps = await JarvisDevice.listApps();
  const visibleLauncherLabels = extractVisibleLauncherLabels(nodeTreeJson);
  const normalizedQuery = normalizeAppText(query);
  const scored = new Map<string, InstalledApp & {score: number; source: string}>();

  for (const app of apps) {
    const normalizedLabel = normalizeAppText(app.label);
    const normalizedPackage = normalizeAppText(app.packageName);
    let score = appScore(normalizedQuery, normalizedLabel, normalizedPackage);
    let source = 'installed_apps';

    const visible = visibleLauncherLabels.some(label => normalizeAppText(label) === normalizedLabel);
    if (score > 0 && visible) {
      score += 8;
      source = 'installed_apps+visible_node';
    }

    if (score > 0) scored.set(app.packageName, {...app, score, source});
  }

  for (const label of visibleLauncherLabels) {
    const normalizedLabel = normalizeAppText(label);
    const matchingApp = apps.find(app => normalizeAppText(app.label) === normalizedLabel);
    if (!matchingApp) continue;
    const score = appScore(normalizedQuery, normalizedLabel, normalizeAppText(matchingApp.packageName)) + 6;
    if (score > 0 && (!scored.get(matchingApp.packageName) || scored.get(matchingApp.packageName)!.score < score)) {
      scored.set(matchingApp.packageName, {...matchingApp, score, source: 'visible_node'});
    }
  }

  const matches = [...scored.values()].sort((a, b) => b.score - a.score).slice(0, 8);
  return {
    query,
    bestMatch: matches[0] ? {label: matches[0].label, packageName: matches[0].packageName} : null,
    matches,
    visibleLauncherLabels,
  };
}

const APP_DISTINGUISHERS = new Set(['music', 'lite', 'go', 'tv', 'studio', 'kids', 'premium']);

function appTokens(value: string): string[] {
  return value.split(' ').filter(Boolean).map(token => (token === 'yt' ? 'youtube' : token));
}

function appScore(queryRaw: string, labelRaw: string, packageRaw: string): number {
  const query = normalizeAppText(queryRaw);
  const label = normalizeAppText(labelRaw);
  const pkg = normalizeAppText(packageRaw);
  if (!query) return 0;
  if (packageRaw.toLowerCase() === queryRaw.toLowerCase()) return 100;
  const queryTokens = appTokens(query);
  const labelTokens = appTokens(label);
  const extra = labelTokens.filter(token => !queryTokens.includes(token));
  const extraDistinguisher = extra.some(token => APP_DISTINGUISHERS.has(token));
  if (label === query || queryTokens.slice().sort().join(' ') === labelTokens.slice().sort().join(' ')) return 95;
  if (extraDistinguisher) return 0;
  const lastSegment = packageRaw.split('.').pop()?.toLowerCase() ?? '';
  if (lastSegment && lastSegment === query.replace(/ /g, '')) return 90;
  if (pkg.replace(/ /g, '') === query.replace(/ /g, '')) return 88;
  if (label.startsWith(query) && extra.length === 0) return 82;
  if (label.includes(query) && extra.length === 0) return 72;
  if (pkg.includes(query) && extra.length === 0 && !labelTokens.some(token => APP_DISTINGUISHERS.has(token))) return 64;
  if (queryTokens.length > 1 && queryTokens.every(token => label.includes(token) || pkg.includes(token))) return 76;
  return 0;
}

function extractVisibleLauncherLabels(nodeTreeJson: string): string[] {
  try {
    const nodes = JSON.parse(nodeTreeJson) as NodeTreeItem[];
    const labels = nodes
      .flatMap(node => [node.text, node.contentDescription])
      .map(value => value?.trim())
      .filter((value): value is string => Boolean(value && value.length <= 80))
      .filter(value => !['apps', 'newsfeed', 'search', 'more options'].includes(normalizeAppText(value)));
    return [...new Set(labels)].slice(0, 80);
  } catch {
    return [];
  }
}

function normalizeAppText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({length: b.length + 1}, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let last = i - 1;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j]!;
      previous[j] = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      last = old;
    }
  }
  return previous[b.length] ?? 0;
}

type LocalPlannerPayload = {
  originalInstruction?: unknown;
  plannerContext?: unknown;
  recentHistory?: unknown;
  currentScreenState?: {
    packageName?: unknown;
    nodeTree?: unknown;
    nodeCount?: unknown;
    lastActionResult?: unknown;
  };
  recentPhoneEvents?: unknown;
};

function buildLocalPlannerPrompt(request: {system: string; prompt: string}): string {
  const payload = parsePlannerPayload(request.prompt);
  if (!payload) {
    return [
      'You are Jarvis running locally on Android.',
      'Return exactly one JSON object and no prose.',
      request.prompt,
    ].join('\n');
  }

  const screen = payload.currentScreenState ?? {};
  const history = compactJson(payload.recentHistory, 360);
  const events = compactJson(payload.recentPhoneEvents, 360);
  // Local models are prompt-sensitive; keep this input semantic and compact so
  // the embedded path follows the same ScreenModel/ContextBuilder boundary.
  const plannerContext = compactJson(payload.plannerContext, 1200);
  const packageName = safeText(screen.packageName, 90) || 'unknown';
  const lastActionResult = safeText(screen.lastActionResult, 220) || 'none';
  const instruction = safeText(payload.originalInstruction, 500);

  return [
    'You are Jarvis running locally on Android.',
    'The user gives you one short task. Reply with only one valid JSON object.',
    'Do not write markdown, notes, code fences, or extra text.',
    'If the task is only greeting, testing, or chatting, complete it with this exact JSON shape:',
    '{"action":"task_complete","summary":"short friendly answer"}',
    'If phone control or device data is needed, choose one action name from: find_and_tap, type, open_app, list_apps, get_device_profile, swipe, wait, get_recent_calls, call, task_complete, task_failed.',
    'For Android version, SDK, phone model, RAM, CPU, storage, battery, or thermal info, use get_device_profile before task_complete.',
    'Prefer find_and_tap using visible text. Avoid coordinates unless absolutely necessary.',
    '',
    `User task: ${instruction}`,
    `Planner context: ${plannerContext}`,
    `Current package: ${packageName}`,
    `Last action result: ${lastActionResult}`,
    `Recent history: ${history}`,
    `Recent phone events: ${events}`,
    'JSON only:',
  ].join('\n');
}

function parsePlannerPayload(prompt: string): LocalPlannerPayload | null {
  try {
    const parsed = JSON.parse(prompt) as LocalPlannerPayload;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function compactJson(value: unknown, max: number): string {
  try {
    return previewText(JSON.stringify(value ?? []), max);
  } catch {
    return '[]';
  }
}

function safeText(value: unknown, max: number): string {
  if (value == null) return '';
  return previewText(String(value), max);
}

function messageType(message: object): string {
  if ('type' in message && typeof message.type === 'string') return message.type;
  return 'unknown_message';
}

function compactMessage(message: object): unknown {
  if ('type' in message && message.type === 'screen_state') {
    const screen = message as {nodeTree?: unknown[]; packageName?: string; lastActionResult?: string | null};
    return {
      type: 'screen_state',
      packageName: screen.packageName ?? '',
      nodeCount: Array.isArray(screen.nodeTree) ? screen.nodeTree.length : 0,
      lastActionResult: screen.lastActionResult ?? null,
    };
  }
  return message;
}

function summarizeBrainEvent(event: Record<string, unknown>): string {
  const kind = String(event.kind ?? 'brain_event');
  if (kind === 'planner_generate_start') {
    return `Planning for ${String(event.instruction ?? '').slice(0, 80)}`;
  }
  if (kind === 'planner_generate_result') {
    return `Model response: ${previewText(String(event.responsePreview ?? ''), 120)}`;
  }
  if (kind === 'planner_parse_success' || kind === 'planner_repair_success') {
    const action = event.action as {action?: string} | undefined;
    return `Parsed action: ${action?.action ?? 'unknown'}`;
  }
  if (kind === 'planner_parse_failed') return 'Model response was not valid JSON action';
  if (kind === 'planner_repair_start') return 'Retrying with JSON-only repair prompt';
  if (kind === 'planner_repair_result') return `Repair response: ${previewText(String(event.responsePreview ?? ''), 120)}`;
  if (kind === 'planner_repair_failed') return 'Repair response was still invalid';
  if (kind === 'task_started') return `Task started: ${String(event.instruction ?? '').slice(0, 80)}`;
  if (kind === 'action') {
    const action = event.action as {action?: string} | undefined;
    return `Brain selected action: ${action?.action ?? 'unknown'}`;
  }
  if (kind === 'action_result') return `Action result: ${previewText(String(event.result ?? ''), 120)}`;
  if (kind === 'task_finished') return 'Task finished';
  if (kind === 'agent_error') return `Agent error: ${String(event.reason ?? '')}`;
  return kind;
}

export const JarvisController = new Controller();
