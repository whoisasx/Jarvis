import type {ProcedureMemory, ProcedureStep} from './procedureMemory.js';
import {sanitizeArgs} from './procedureMemory.js';
import type {ToolObservation} from './toolTypes.js';

export interface EpisodeStep {
  capability: string;
  args: Record<string, unknown>;
  success: boolean;
  app?: string;
  screen?: string;
  error?: string;
}

const SKIP = new Set([
  'search_memory', 'get_relevant_context', 'get_similar_procedures',
  'remember_procedure', 'complete_task', 'get_world_state', 'get_recent_events',
  'get_notifications', 'get_device_profile', 'get_recent_calls', 'get_recent_sms',
  'read_sms', 'list_apps', 'resolve_app',
]);

export class ProcedureLearner {
  private readonly episodes = new Map<string, {goal: string; steps: EpisodeStep[]; startedAt: number}>();

  constructor(private readonly memory: ProcedureMemory) {}

  setGoal(sessionId: string, goal: string): void {
    const trimmed = goal.trim();
    if (!trimmed) return;
    const existing = this.episodes.get(sessionId);
    if (existing && existing.goal && existing.goal !== trimmed && existing.steps.length >= 4) {
      this.commit(sessionId, 'success', 'Goal changed; saved the previous episode');
    }
    if (!existing || existing.goal !== trimmed) {
      this.episodes.set(sessionId, {goal: trimmed, steps: [], startedAt: Date.now()});
    }
  }

  record(sessionId: string, input: {
    capability: string;
    args?: Record<string, unknown>;
    success: boolean;
    observation?: ToolObservation;
    error?: string;
    goal?: string | null;
  }): void {
    if (input.goal) this.setGoal(sessionId, input.goal);
    let episode = this.episodes.get(sessionId);
    if (!episode) {
      episode = {goal: input.goal?.trim() || input.observation?.currentAppLabel || 'device task', steps: [], startedAt: Date.now()};
      this.episodes.set(sessionId, episode);
    }
    episode.steps.push({
      capability: input.capability,
      args: sanitizeArgs(input.args ?? {}),
      success: input.success,
      app: input.observation?.currentApp,
      screen: input.observation?.screen,
      error: input.error,
    });
    if (episode.steps.length > 80) episode.steps = episode.steps.slice(-80);
  }

  commit(sessionId: string, outcome: 'success' | 'failed', notes?: string): ReturnType<ProcedureMemory['remember']> | null {
    const episode = this.episodes.get(sessionId);
    if (!episode) return null;
    const playbook = distill(episode.steps);
    if (playbook.length === 0) return null;
    const apps = unique(episode.steps.map(step => step.app).filter((app): app is string => Boolean(app)));
    const pitfalls = unique(episode.steps.filter(step => !step.success && step.error).map(step => `${step.capability}: ${step.error}`)).slice(0, 8);
    if (notes) pitfalls.unshift(notes);
    const saved = this.memory.remember({
      goal: episode.goal,
      apps,
      playbook,
      pitfalls,
      outcome,
      source: 'learned',
    });
    this.episodes.delete(sessionId);
    return saved;
  }

  hint(goal: string | null | undefined, app?: string) {
    const hits = this.memory.retrieve({goal: goal || app || '', app, limit: 1});
    return hits[0] ?? null;
  }
}

function distill(steps: EpisodeStep[]): ProcedureStep[] {
  const playbook: ProcedureStep[] = [];
  for (const step of steps) {
    if (SKIP.has(step.capability)) continue;
    if (step.capability === 'read_screen' && playbook.at(-1)?.capability === 'read_screen') continue;
    if (!step.success && playbook.length === 0) continue;
    const last = playbook.at(-1);
    const same = last && last.capability === step.capability && JSON.stringify(last.args ?? {}) === JSON.stringify(step.args);
    if (same) continue;
    playbook.push({
      capability: step.capability,
      args: Object.keys(step.args).length ? step.args : undefined,
      note: step.success ? step.screen : step.error,
    });
  }
  return playbook.slice(0, 24);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
