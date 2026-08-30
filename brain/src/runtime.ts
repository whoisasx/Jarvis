import {AndroidAgent} from './agent.js';
import {CapabilityManager} from './capabilityManager.js';
import {ContextBuilder} from './contextBuilder.js';
import {DeviceExecutor} from './deviceExecutor.js';
import {EventBus, normalizePhoneMessage, type JarvisEvent} from './eventBus.js';
import {EventHistory} from './eventHistory.js';
import {AgentGateway} from './gateway.js';
import {GoalManager} from './goalManager.js';
import type {LlmRuntime} from './llmRuntime.js';
import {logEvent} from './logger.js';
import {MemoryCore} from './memoryCore.js';
import {ProcedureLearner} from './procedureLearner.js';
import {ProcedureMemory, type ProcedureStore} from './procedureMemory.js';
import type {PhoneTransport} from './phoneTransport.js';
import type {PhoneMessage} from './protocol.js';
import {RuleEngine, type RuleDecision} from './ruleEngine.js';
import {ScreenObserver} from './screenObserver.js';
import {TaskManager} from './taskManager.js';
import type {OrchestrationMode} from './toolTypes.js';
import {WorkingMemory} from './workingMemory.js';
import {WorldStateManager} from './worldState.js';

export interface BrainRuntimeOptions {
  llm: LlmRuntime;
  phone?: PhoneTransport;
  procedureStore?: ProcedureStore | null;
}

export interface BrainStatus {
  running: boolean;
  phoneConnected: boolean;
  activeTask: ReturnType<TaskManager['getTask']>;
  llmProvider: string;
  llmModel: string;
  workingMemory: ReturnType<WorkingMemory['snapshot']>;
  worldState: ReturnType<WorldStateManager['snapshot']>;
  lastPlannerContext: ReturnType<TaskManager['getLastPlannerContext']>;
  recentEvents: ReturnType<EventHistory['recent']>;
  memoryCandidates: ReturnType<MemoryCore['snapshot']>;
  goals: ReturnType<GoalManager['snapshot']>;
  orchestration: OrchestrationMode;
  gateway: ReturnType<AgentGateway['status']>;
}

/**
 * Runtime boundary for Jarvis Brain.
 *
 * Planner, agents, task manager, and future memory live behind this interface.
 * Android React Native, a future service-owned Javet/Node host, desktop, or
 * the development server should all integrate through this runtime instead of
 * importing business logic directly.
 */
export class BrainRuntime {
  private readonly manager: TaskManager;
  private readonly eventBus = new EventBus();
  private readonly ruleEngine = new RuleEngine();
  private readonly eventHistory = new EventHistory();
  private readonly workingMemory = new WorkingMemory();
  private readonly worldState = new WorldStateManager();
  private readonly screenObserver = new ScreenObserver();
  private readonly procedureMemory: ProcedureMemory;
  private readonly procedureLearner: ProcedureLearner;
  private readonly contextBuilder: ContextBuilder;
  private readonly memory = new MemoryCore();
  private readonly goals = new GoalManager();
  private readonly capabilityManager = new CapabilityManager();
  private readonly deviceExecutor: DeviceExecutor;
  readonly gateway: AgentGateway;
  private readonly eventDecisions = new Map<string, RuleDecision>();
  private readonly orchestration: OrchestrationMode;
  private running = false;

  constructor(private readonly options: BrainRuntimeOptions) {
    this.procedureMemory = new ProcedureMemory(options.procedureStore);
    this.procedureLearner = new ProcedureLearner(this.procedureMemory);
    this.contextBuilder = new ContextBuilder(this.procedureMemory);
    this.orchestration = process.env.JARVIS_ORCHESTRATION === 'legacy' ? 'legacy' : 'external';
    this.eventBus.subscribe(event => this.routeEvent(event));
    this.deviceExecutor = new DeviceExecutor(this.screenObserver, this.worldState);
    this.gateway = new AgentGateway({
      eventBus: this.eventBus,
      capabilityManager: this.capabilityManager,
      deviceExecutor: this.deviceExecutor,
      worldState: this.worldState,
      workingMemory: this.workingMemory,
      eventHistory: this.eventHistory,
      memory: this.memory,
      procedureMemory: this.procedureMemory,
      procedureLearner: this.procedureLearner,
      contextBuilder: this.contextBuilder,
      orchestration: this.orchestration,
    });
    this.manager = new TaskManager(new AndroidAgent(options.llm), {
      eventBus: this.eventBus,
      capabilityManager: this.capabilityManager,
      contextBuilder: this.contextBuilder,
      worldState: this.worldState,
      workingMemory: this.workingMemory,
      eventHistory: this.eventHistory,
    });
    if (options.phone) this.attachPhone(options.phone);
  }

  start(phone?: PhoneTransport): void {
    this.running = true;
    if (phone) this.attachPhone(phone);
  }

  stop(): void {
    this.running = false;
  }

  attachPhone(phone: PhoneTransport): void {
    this.manager.attachPhone(phone);
    this.deviceExecutor.attachPhone(phone);
  }

  async submitTask(instruction: string): Promise<string> {
    if (!this.running) this.start();
    this.goals.createGoal(instruction, 'developer.task');
    this.publishEvent({
      type: 'developer.task_submitted',
      source: 'developer.ui',
      priority: 'high',
      payload: {instruction},
    });
    if (this.orchestration === 'legacy') {
      return this.manager.startTask(instruction);
    }
    const session = await this.gateway.submitGoal(instruction, 'developer.ui');
    return session.sessionId;
  }

  async receivePhoneMessage(message: PhoneMessage): Promise<void> {
    const screenModel = message.type === 'screen_state' ? this.screenObserver.observe(message) : undefined;
    const decisions = normalizePhoneMessage(message, screenModel).map(draft => this.publishEvent(draft));
    const shouldProcess = decisions.some(({decision}) => decision.action === 'allow');
    if (!shouldProcess) return;

    if (message.type === 'screen_state') {
      const consumed = this.deviceExecutor.handleScreenState(message);
      if (!consumed && this.orchestration === 'legacy') {
        await this.manager.onScreenState(message);
      }
    } else {
      await this.manager.logPassiveEvent(message);
    }
  }

  getStatus(): BrainStatus {
    return {
      running: this.running,
      phoneConnected: this.deviceExecutor.hasPhone(),
      activeTask: this.manager.getTask(),
      llmProvider: this.options.llm.provider,
      llmModel: this.options.llm.model,
      workingMemory: this.workingMemory.snapshot(),
      worldState: this.worldState.snapshot(),
      lastPlannerContext: this.manager.getLastPlannerContext(),
      recentEvents: this.eventHistory.recent(40),
      memoryCandidates: this.memory.snapshot(),
      goals: this.goals.snapshot(),
      orchestration: this.orchestration,
      gateway: this.gateway.status(),
    };
  }

  private publishEvent(draft: Parameters<EventBus['publish']>[0]): {event: JarvisEvent; decision: RuleDecision} {
    const event = this.eventBus.publish(draft);
    const decision = this.eventDecisions.get(event.id) ?? this.defaultDecision(event);
    return {event, decision};
  }

  private routeEvent(event: JarvisEvent): void {
    const decision = this.ruleEngine.decide(event);
    this.eventDecisions.set(event.id, decision);
    if (this.eventDecisions.size > 300) {
      const first = this.eventDecisions.keys().next().value;
      if (first) this.eventDecisions.delete(first);
    }
    this.eventHistory.record(event, decision);
    this.workingMemory.observe(event);
    this.worldState.observe(event);
    this.memory.observe(event);
    logEvent({
      kind: 'event',
      eventType: event.type,
      source: event.source,
      priority: event.priority,
      decision: decision.action,
      wakePlanner: decision.wakePlanner,
      reason: decision.reason,
      payload: event.payload,
    }).catch(() => undefined);
  }

  private defaultDecision(event: JarvisEvent): RuleDecision {
    return {
      eventId: event.id,
      eventType: event.type,
      action: 'allow',
      wakePlanner: false,
      reason: 'event accepted before recorder returned',
      timestamp: Date.now(),
    };
  }
}
