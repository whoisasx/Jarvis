export interface ProcedureStep {
  capability: string;
  args?: Record<string, unknown>;
  note?: string;
}

export interface LearnedProcedure {
  id: string;
  goal: string;
  apps: string[];
  playbook: ProcedureStep[];
  pitfalls: string[];
  outcome: 'success' | 'failed';
  uses: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  source: 'seed' | 'learned';
}

export interface RetrievedProcedure extends LearnedProcedure {
  score: number;
  why: string;
}

export interface ProcedureStore {
  load(): LearnedProcedure[];
  save(procedures: LearnedProcedure[]): void;
}

const STOP = new Set([
  'the', 'and', 'for', 'from', 'with', 'this', 'that', 'your', 'you', 'me',
  'a', 'an', 'to', 'of', 'in', 'on', 'at', 'is', 'it', 'my', 'do', 'please',
]);

export class ProcedureMemory {
  private procedures = new Map<string, LearnedProcedure>();
  private readonly store: ProcedureStore | null;

  constructor(store?: ProcedureStore | null) {
    this.store = store ?? null;
    this.load();
    this.ensureSeeds();
  }

  snapshot(): LearnedProcedure[] {
    return [...this.procedures.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  remember(input: {
    goal: string;
    apps?: string[];
    playbook: ProcedureStep[];
    pitfalls?: string[];
    outcome: 'success' | 'failed';
    source?: 'seed' | 'learned';
  }): LearnedProcedure {
    const goal = redact(input.goal).trim();
    if (!goal) throw new Error('goal is required');
    const playbook = input.playbook.map(step => ({
      capability: step.capability,
      args: step.args ? sanitizeArgs(step.args) : undefined,
      note: step.note ? redact(step.note) : undefined,
    }));
    const apps = unique((input.apps ?? []).map(app => app.trim()).filter(Boolean));
    const existing = this.findMergeTarget(goal, apps, playbook);
    const now = Date.now();
    if (existing) {
      existing.goal = existing.uses > 2 ? existing.goal : goal;
      existing.apps = unique([...existing.apps, ...apps]);
      existing.playbook = mergePlaybooks(existing.playbook, playbook);
      existing.pitfalls = unique([...(existing.pitfalls ?? []), ...(input.pitfalls ?? []).map(redact)]);
      existing.outcome = input.outcome === 'success' ? 'success' : existing.outcome;
      existing.uses += 1;
      existing.updatedAt = now;
      existing.lastUsedAt = now;
      this.persist();
      return existing;
    }
    const created: LearnedProcedure = {
      id: `proc-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      goal,
      apps,
      playbook,
      pitfalls: unique((input.pitfalls ?? []).map(redact)),
      outcome: input.outcome,
      uses: 1,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
      source: input.source ?? 'learned',
    };
    this.procedures.set(created.id, created);
    this.persist();
    return created;
  }

  retrieve(query: {goal: string; app?: string; limit?: number}): RetrievedProcedure[] {
    const goal = query.goal.trim();
    if (!goal) return [];
    const limit = Math.max(1, Math.min(8, query.limit ?? 3));
    const goalTokens = tokenize(goal);
    const scored = [...this.procedures.values()].map(procedure => {
      const text = [procedure.goal, procedure.apps.join(' '), procedure.playbook.map(step => `${step.capability} ${JSON.stringify(step.args ?? {})}`).join(' '), procedure.pitfalls.join(' ')].join(' ');
      const tokens = tokenize(text);
      let score = overlapScore(goalTokens, tokens);
      const app = query.app;
      if (app && procedure.apps.some(item => item === app || text.includes(app))) score += 4;
      if (conflictingIntent(goal, procedure.goal)) score -= 6;
      if (procedure.outcome === 'success') score += 1.5;
      score += Math.min(2, procedure.uses * 0.25);
      const why = [
        query.app && procedure.apps.includes(query.app) ? `same app ${query.app}` : '',
        procedure.outcome === 'success' ? 'worked before' : 'failed before',
        `used ${procedure.uses}x`,
      ].filter(Boolean).join(', ');
      return {procedure, score, why};
    }).filter(item => item.score >= 2);
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    const now = Date.now();
    for (const item of top) {
      item.procedure.lastUsedAt = now;
    }
    if (top.length) this.persist();
    return top.map(item => ({...item.procedure, score: Number(item.score.toFixed(2)), why: item.why}));
  }

  private findMergeTarget(goal: string, apps: string[], playbook: ProcedureStep[]): LearnedProcedure | undefined {
    const goalTokens = tokenize(goal);
    return [...this.procedures.values()].find(procedure => {
      const sameApp = apps.length === 0 || procedure.apps.some(app => apps.includes(app));
      if (conflictingIntent(goal, procedure.goal)) return false;
      const similarGoal = overlapScore(goalTokens, tokenize(procedure.goal)) >= 3;
      const similarPlay = overlapScore(
        tokenize(playbook.map(step => step.capability).join(' ')),
        tokenize(procedure.playbook.map(step => step.capability).join(' ')),
      ) >= 1;
      return sameApp && similarGoal && similarPlay;
    });
  }

  private ensureSeeds(): void {
    for (const seed of SEEDS) {
      const exists = [...this.procedures.values()].some(item => item.source === 'seed' && item.goal === seed.goal);
      if (!exists) {
        this.remember({...seed, source: 'seed'});
      }
    }
  }

  private load(): void {
    if (!this.store) return;
    for (const item of this.store.load()) {
      if (item.id && item.goal) this.procedures.set(item.id, item);
    }
  }

  private persist(): void {
    this.store?.save([...this.procedures.values()]);
  }
}

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => (token.length > 2 || /^\d{2,}$/.test(token)) && !STOP.has(token));
}

export function overlapScore(query: string[], document: string[]): number {
  if (query.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const token of document) counts.set(token, (counts.get(token) ?? 0) + 1);
  let score = 0;
  for (const token of new Set(query)) {
    const tf = counts.get(token) ?? 0;
    if (tf === 0) continue;
    score += 1 + Math.log(1 + tf);
  }
  return score;
}

export function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value == null) continue;
    if (typeof value === 'string') {
      const cleaned = redact(value);
      if (cleaned) out[key] = cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

export function redact(value: string): string {
  return value
    .replace(/\b\d{4,}\b/g, '[number]')
    .replace(/\b(?:pin|otp|password|token)\b\s*[:=]?\s*\S+/gi, '[redacted]');
}

function conflictingIntent(left: string, right: string): boolean {
  const cancel = /\bcancel|\bstop ride|\bundo\b/;
  return cancel.test(left.toLowerCase()) !== cancel.test(right.toLowerCase());
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function mergePlaybooks(current: ProcedureStep[], incoming: ProcedureStep[]): ProcedureStep[] {
  if (incoming.length >= current.length) return incoming.slice(0, 24);
  return current.slice(0, 24);
}

const SEEDS: Array<Omit<LearnedProcedure, 'id' | 'uses' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'source'> & {source?: 'seed'}> = [
  {
    goal: 'Book a Rapido bike from current location to a metro station',
    apps: ['com.rapido.passenger'],
    outcome: 'success',
    pitfalls: [
      'Rapido may show Uh oh we cannot find you. Confirm pickup on the map instead of waiting.',
      'Promos and chat sheets hide the trip. Close them, do not send quick chat.',
      'Book Bike may first open Confirm pickup. Confirm the map pin before expecting a captain.',
      'find_and_click on long accessibility labels can be NOT_CLICKABLE. Use a shorter unique label.',
    ],
    playbook: [
      {capability: 'resolve_app', args: {appName: 'Rapido'}},
      {capability: 'open_app', args: {packageName: 'com.rapido.passenger'}},
      {capability: 'read_screen', note: 'Wait if it is still locating the user'},
      {capability: 'find_and_click', args: {text: 'Where do you want to go?'}},
      {capability: 'find_and_click', args: {text: 'Select Pickup'}, note: 'Use map pickup when GPS fails'},
      {capability: 'type_text', args: {text: 'destination name'}, note: 'Or pick a matching recent suggestion'},
      {capability: 'find_and_click', args: {text: 'Bike'}},
      {capability: 'find_and_click', args: {text: 'Confirm pickup'}},
      {capability: 'read_screen', note: 'Expect captain on the way, vehicle number, and start PIN'},
    ],
  },
  {
    goal: 'Cancel an active Rapido ride',
    apps: ['com.rapido.passenger'],
    outcome: 'success',
    pitfalls: [
      'Cancel is under Trip Details, not on the live map sheet.',
      'Rapido may charge a cancellation fee. Confirm Cancel (₹) only if the user asked to cancel.',
    ],
    playbook: [
      {capability: 'open_app', args: {packageName: 'com.rapido.passenger'}},
      {capability: 'find_and_click', args: {text: 'Trip Details'}},
      {capability: 'find_and_click', args: {text: 'Cancel Ride'}},
      {capability: 'find_and_click', args: {text: 'Change of plans'}},
      {capability: 'find_and_click', args: {text: 'Cancel'}, note: 'Confirm fee if the user already asked to cancel'},
      {capability: 'read_screen', note: 'Success when there is no Active Order and home or choose-ride is shown'},
    ],
  },
];
