function randomUUID(): string {
  const hex = Math.random().toString(16).substring(2, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
import {CAPABILITY_CATALOG, findCapability} from './capabilityCatalog.js';
import type {CapabilityManager} from './capabilityManager.js';
import type {ContextBuilder} from './contextBuilder.js';
import type {DeviceExecutor} from './deviceExecutor.js';
import type {EventBus} from './eventBus.js';
import type {EventHistory} from './eventHistory.js';
import {logEvent} from './logger.js';
import type {MemoryCore} from './memoryCore.js';
import type {ProcedureLearner} from './procedureLearner.js';
import type {ProcedureMemory} from './procedureMemory.js';
import type {AgentSessionSnapshot, OrchestrationMode, ToolError, ToolObservation, ToolResponse} from './toolTypes.js';
import type {WorkingMemory} from './workingMemory.js';
import type {WorldStateManager} from './worldState.js';
import type {AgentAction} from './protocol.js';
import {inferErrorCode, parseActionResult} from './actionResult.js';

export interface GatewayDependencies {
  eventBus: EventBus;
  capabilityManager: CapabilityManager;
  deviceExecutor: DeviceExecutor;
  worldState: WorldStateManager;
  workingMemory: WorkingMemory;
  eventHistory: EventHistory;
  memory: MemoryCore;
  procedureMemory: ProcedureMemory;
  procedureLearner: ProcedureLearner;
  contextBuilder: ContextBuilder;
  orchestration: OrchestrationMode;
}

interface SessionRecord extends AgentSessionSnapshot {
  invokeTimes: number[];
}

const RATE_LIMIT_PER_MINUTE = 90;

export class AgentGateway {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly deps: GatewayDependencies) {}

  listTools() {
    return CAPABILITY_CATALOG.map(item => ({
      name: item.name,
      description: item.description,
      sensitive: item.sensitive,
      kind: item.kind,
      inputSchema: item.inputSchema,
    }));
  }

  createSession(input: {agentName?: string; protocol?: AgentSessionSnapshot['protocol']; goal?: string} = {}): AgentSessionSnapshot {
    const session: SessionRecord = {
      sessionId: randomUUID(),
      agentName: input.agentName?.trim() || 'external-agent',
      protocol: input.protocol ?? 'http',
      createdAt: Date.now(),
      lastRequestId: null,
      lastCapability: null,
      lastSuccess: null,
      lastObservationSummary: null,
      goal: input.goal?.trim() || null,
      status: input.goal ? 'waiting_for_agent' : 'idle',
      invokeTimes: [],
    };
    this.sessions.set(session.sessionId, session);
    if (session.goal) this.deps.procedureLearner.setGoal(session.sessionId, session.goal);
    this.deps.eventBus.publish({
      type: 'gateway.session_created',
      source: 'brain.gateway',
      priority: 'normal',
      payload: {sessionId: session.sessionId, agentName: session.agentName, protocol: session.protocol},
    });
    return this.publicSession(session);
  }

  getSession(sessionId: string): AgentSessionSnapshot | null {
    const session = this.sessions.get(sessionId);
    return session ? this.publicSession(session) : null;
  }

  latestSession(): AgentSessionSnapshot | null {
    const latest = [...this.sessions.values()].at(-1);
    return latest ? this.publicSession(latest) : null;
  }

  async submitGoal(goal: string, agentName = 'external-agent'): Promise<{sessionId: string; status: string; message: string}> {
    const session = this.createSession({agentName, protocol: 'http', goal});
    return {
      sessionId: session.sessionId,
      status: session.status,
      message: 'Jarvis accepted the goal. An external agent must discover tools and invoke capabilities. Jarvis will not run an internal planner loop.',
    };
  }

  async invoke(input: {
    requestId?: string;
    sessionId: string;
    capability: string;
    arguments?: Record<string, unknown>;
    confirmSensitive?: boolean;
    agentName?: string;
    protocol?: AgentSessionSnapshot['protocol'];
  }): Promise<ToolResponse> {
    const requestId = input.requestId ?? randomUUID();
    const session = this.ensureSession(input.sessionId, input.agentName, input.protocol);
    if (!this.allowRate(session)) {
      return fail(requestId, session.sessionId, input.capability, {
        code: 'RATE_LIMITED',
        message: `Too many capability invocations (max ${RATE_LIMIT_PER_MINUTE}/min)`,
      });
    }

    const descriptor = findCapability(input.capability);
    if (!descriptor) {
      return fail(requestId, session.sessionId, input.capability, {
        code: 'UNKNOWN_CAPABILITY',
        message: `Capability ${input.capability} is not exposed`,
      });
    }

    if (descriptor.sensitive && !input.confirmSensitive) {
      return fail(requestId, session.sessionId, input.capability, {
        code: 'CONFIRMATION_REQUIRED',
        message: `${descriptor.name} is a sensitive device action. Retry with confirmSensitive=true.`,
      }, this.deps.deviceExecutor.currentObservation());
    }

    let action: AgentAction | null = null;
    try {
      action = descriptor.toAction ? descriptor.toAction(input.arguments ?? {}) : null;
    } catch (error) {
      return fail(requestId, session.sessionId, input.capability, {
        code: 'INVALID_ARGUMENTS',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (action) {
      const check = this.deps.capabilityManager.checkAction(action);
      this.deps.eventBus.publish({
        type: 'capability.check',
        source: 'brain.gateway',
        priority: check.available ? 'low' : 'high',
        payload: {capability: input.capability, available: check.available, reason: check.reason ?? null},
        correlationId: requestId,
      });
      if (!check.available) {
        return fail(requestId, session.sessionId, input.capability, {
          code: 'CAPABILITY_UNAVAILABLE',
          message: check.reason ?? 'Required Android capability is unavailable',
          details: check.required,
        }, this.deps.deviceExecutor.currentObservation());
      }
    }

    session.status = 'executing';
    session.lastRequestId = requestId;
    session.lastCapability = input.capability;
    this.deps.eventBus.publish({
      type: 'gateway.tool_invoked',
      source: 'brain.gateway',
      priority: descriptor.sensitive ? 'high' : 'normal',
      payload: {requestId, sessionId: session.sessionId, capability: input.capability, agentName: session.agentName},
      correlationId: requestId,
    });
    void logEvent({kind: 'gateway_invoke', requestId, sessionId: session.sessionId, capability: input.capability});

    try {
      const response = await this.execute(requestId, session.sessionId, descriptor.name, input.arguments ?? {}, action, session);
      session.lastSuccess = response.success;
      session.lastObservationSummary = response.observation?.summary ?? null;
      session.status = descriptor.name === 'complete_task'
        ? (response.success ? 'completed' : 'failed')
        : 'waiting_for_agent';
      this.deps.procedureLearner.record(session.sessionId, {
        capability: input.capability,
        args: input.arguments,
        success: response.success,
        observation: response.observation,
        error: response.error?.code,
        goal: session.goal,
      });
      response.observation = this.withPlaybook(response.observation, session.goal);
      this.deps.eventBus.publish({
        type: 'gateway.tool_completed',
        source: 'brain.gateway',
        priority: response.success ? 'normal' : 'high',
        payload: {
          requestId,
          sessionId: session.sessionId,
          capability: input.capability,
          success: response.success,
          errorCode: response.error?.code ?? null,
        },
        correlationId: requestId,
      });
      return response;
    } catch (error) {
      session.lastSuccess = false;
      session.status = 'waiting_for_agent';
      return fail(requestId, session.sessionId, input.capability, {
        code: 'EXECUTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      }, this.deps.deviceExecutor.currentObservation());
    }
  }

  status() {
    return {
      orchestration: this.deps.orchestration,
      phoneConnected: this.deps.deviceExecutor.hasPhone(),
      session: this.latestSession(),
      toolCount: CAPABILITY_CATALOG.length,
    };
  }

  private withPlaybook(observation: ToolObservation | undefined, goal: string | null): ToolObservation | undefined {
    if (!observation) return observation;
    const hit = this.deps.procedureLearner.hint(goal, observation.currentApp);
    if (!hit) return observation;
    return {
      ...observation,
      learnedPlaybook: {
        goal: hit.goal,
        score: hit.score,
        why: hit.why,
        apps: hit.apps,
        steps: hit.playbook,
        pitfalls: hit.pitfalls,
      },
    };
  }

  private async execute(
    requestId: string,
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    action: AgentAction | null,
    session: SessionRecord,
  ): Promise<ToolResponse> {
    if (name === 'read_screen') {
      const {observation, screen} = await this.deps.deviceExecutor.requestScreen();
      return ok(requestId, sessionId, name, {
        nodeCount: screen.nodeTree.length,
        treeAvailable: (screen.treeAvailable ?? screen.nodeTree.length > 0),
        observationReason: screen.observationReason ?? (screen.nodeTree.length === 0 ? 'EMPTY_TREE' : null),
        observationFresh: screen.observationFresh ?? true,
        summary: observation.summary,
      }, observation);
    }
    if (name === 'get_world_state') {
      return ok(requestId, sessionId, name, this.deps.worldState.snapshot(), this.deps.deviceExecutor.currentObservation());
    }
    if (name === 'get_recent_events') {
      const limit = clampNumber(args.limit, 20, 1, 80);
      return ok(requestId, sessionId, name, this.deps.eventHistory.recent(limit).map(compactEvent), this.deps.deviceExecutor.currentObservation());
    }
    if (name === 'search_memory') {
      const query = String(args.query ?? '');
      const limit = clampNumber(args.limit, 20, 1, 50);
      return ok(requestId, sessionId, name, {
        events: this.deps.eventHistory.search(query, limit).map(compactEvent),
        memoryCandidates: this.deps.memory.snapshot().filter(item => JSON.stringify(item).toLowerCase().includes(query.toLowerCase())),
        procedures: this.deps.procedureMemory.retrieve({goal: query, limit}),
      }, this.deps.deviceExecutor.currentObservation());
    }
    if (name === 'get_similar_procedures') {
      const goal = String(args.goal ?? session.goal ?? '');
      if (goal && !session.goal) session.goal = goal;
      if (goal) this.deps.procedureLearner.setGoal(sessionId, goal);
      const procedures = this.deps.procedureMemory.retrieve({
        goal,
        app: this.deps.worldState.snapshot().currentApp,
        limit: clampNumber(args.limit, 3, 1, 8),
      });
      return ok(requestId, sessionId, name, {goal, procedures}, this.deps.deviceExecutor.currentObservation());
    }
    if (name === 'remember_procedure' || name === 'complete_task') {
      const goal = String(args.goal ?? session.goal ?? '');
      if (goal) {
        session.goal = goal;
        this.deps.procedureLearner.setGoal(sessionId, goal);
      }
      const outcome = args.outcome === 'failed' ? 'failed' : 'success';
      const notes = typeof args.notes === 'string' ? args.notes : undefined;
      const saved = this.deps.procedureLearner.commit(sessionId, outcome, notes)
        ?? (goal
          ? this.deps.procedureMemory.remember({
            goal,
            playbook: [],
            pitfalls: notes ? [notes] : [],
            outcome,
            apps: [this.deps.worldState.snapshot().currentApp].filter(Boolean),
          })
          : null);
      if (saved) {
        this.deps.eventBus.publish({
          type: 'memory.procedure_recorded',
          source: 'brain.gateway',
          payload: {procedureId: saved.id, goal: saved.goal, outcome: saved.outcome, uses: saved.uses},
        });
      }
      return ok(requestId, sessionId, name, {saved, remembered: Boolean(saved)}, this.deps.deviceExecutor.currentObservation());
    }
    if (name === 'get_relevant_context') {
      const goal = String(args.goal ?? '');
      if (goal) {
        session.goal = session.goal || goal;
        this.deps.procedureLearner.setGoal(sessionId, goal);
      }
      this.deps.eventBus.publish({type: 'memory.context_requested', source: 'brain.gateway', payload: {goal}});
      const context = this.deps.contextBuilder.build({
        task: goal,
        worldState: this.deps.worldState.snapshot(),
        workingMemory: this.deps.workingMemory.snapshot(),
        recentEvents: this.deps.eventHistory.recent(80),
      });
      this.deps.eventBus.publish({type: 'memory.context_returned', source: 'brain.gateway', payload: {goal, summary: context.summary}});
      if (context.relevantProcedures[0]) {
        this.deps.eventBus.publish({
          type: 'memory.procedure_retrieved',
          source: 'brain.gateway',
          payload: {goal, procedureId: context.relevantProcedures[0].id, score: context.relevantProcedures[0].score},
        });
      }
      return ok(requestId, sessionId, name, context, this.deps.deviceExecutor.currentObservation());
    }

    if (name === 'get_notifications') {
      const limit = clampNumber(args.limit, 20, 1, 50);
      const world = this.deps.worldState.snapshot();
      const recent = this.deps.eventHistory
        .recent(80)
        .filter(entry => entry.event.type === 'notification.received' || entry.event.type === 'notification.removed')
        .slice(0, limit)
        .map(compactEvent);
      return ok(requestId, sessionId, name, {lastNotification: world.lastNotification, recent}, this.deps.deviceExecutor.currentObservation());
    }

    if (!action) throw new Error(`Capability ${name} cannot be executed`);
    const executed = await this.deps.deviceExecutor.executeAction(action, requestId);
    const parsed = parseActionResult(executed.result);
    return {
      requestId,
      sessionId,
      capability: name,
      success: parsed.success,
      result: parsed.data,
      observation: executed.observation,
      error: parsed.success ? undefined : {code: inferErrorCode(executed.result), message: executed.result},
    };
  }

  private ensureSession(sessionId: string, agentName?: string, protocol?: AgentSessionSnapshot['protocol']): SessionRecord {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created = this.createSession({agentName, protocol});
    const record = this.sessions.get(created.sessionId);
    if (!record) throw new Error('Failed to create gateway session');
    this.sessions.delete(created.sessionId);
    record.sessionId = sessionId;
    this.sessions.set(sessionId, record);
    return record;
  }

  private allowRate(session: SessionRecord): boolean {
    const cutoff = Date.now() - 60_000;
    session.invokeTimes = session.invokeTimes.filter(time => time > cutoff);
    if (session.invokeTimes.length >= RATE_LIMIT_PER_MINUTE) return false;
    session.invokeTimes.push(Date.now());
    return true;
  }

  private publicSession(session: SessionRecord): AgentSessionSnapshot {
    const {invokeTimes: _invokeTimes, ...rest} = session;
    return rest;
  }
}

function ok(requestId: string, sessionId: string, capability: string, result: unknown, observation?: ToolObservation): ToolResponse {
  return {requestId, sessionId, capability, success: true, result, observation};
}

function fail(requestId: string, sessionId: string, capability: string, error: ToolError, observation?: ToolObservation): ToolResponse {
  return {requestId, sessionId, capability, success: false, error, observation};
}

function compactEvent(entry: {event: {type: string; source: string; timestamp: number; priority: string; payload: Record<string, unknown>}; decision?: {action?: string}}) {
  return {
    type: entry.event.type,
    source: entry.event.source,
    timestamp: entry.event.timestamp,
    priority: entry.event.priority,
    payload: entry.event.payload,
    decision: entry.decision?.action,
  };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
