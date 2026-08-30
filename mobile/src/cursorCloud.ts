const CURSOR_API_BASE = 'https://api.cursor.com';
const DEFAULT_MODEL = 'composer-2.5';

export interface CursorModelInfo {
  id: string;
  displayName: string;
  description?: string;
}

export interface CursorAccountInfo {
  apiKeyName?: string;
  userEmail?: string;
  userFirstName?: string;
  userLastName?: string;
}

export interface CursorCloudOptions {
  apiKey: string;
  modelId?: string;
  onEvent?: (kind: string, detail: string, data?: unknown) => void;
}

interface GenerateRequest {
  system: string;
  prompt: string;
  screenshotBase64?: string;
  screenshotMediaType?: 'image/png' | 'image/jpeg' | 'image/webp';
  maxTokens?: number;
  temperature?: number;
  responseMimeType?: 'application/json' | 'text/plain';
}

function basicAuth(apiKey: string): string {
  return `Basic ${btoa(`${apiKey}:`)}`;
}

async function cursorFetch(apiKey: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${CURSOR_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: basicAuth(apiKey),
      Accept: 'application/json',
      ...(init?.body ? {'Content-Type': 'application/json'} : {}),
      ...(init?.headers ?? {}),
    },
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Cursor API returned non-JSON (${response.status}): ${text.slice(0, 240)}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringField(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  const field = record?.[key];
  return typeof field === 'string' && field.trim() ? field : undefined;
}

export async function getCursorAccount(apiKey: string): Promise<CursorAccountInfo> {
  const response = await cursorFetch(apiKey, '/v1/me');
  const body = await readJson(response);
  if (!response.ok) throw new Error(cursorError(response.status, body));
  return {
    apiKeyName: stringField(body, 'apiKeyName'),
    userEmail: stringField(body, 'userEmail'),
    userFirstName: stringField(body, 'userFirstName'),
    userLastName: stringField(body, 'userLastName'),
  };
}

type CursorModelParam = {id: string; value: string};

export async function listCursorModels(apiKey: string): Promise<CursorModelInfo[]> {
  const catalog = await fetchCursorCatalog(apiKey);
  return catalog.map(item => ({
    id: item.id,
    displayName: item.displayName,
    description: item.description,
  }));
}

interface CursorCatalogModel {
  id: string;
  displayName: string;
  description?: string;
  aliases: string[];
  variants: Array<{params: CursorModelParam[]; isDefault: boolean}>;
}

async function fetchCursorCatalog(apiKey: string): Promise<CursorCatalogModel[]> {
  const response = await cursorFetch(apiKey, '/v1/models');
  const body = await readJson(response);
  if (!response.ok) throw new Error(cursorError(response.status, body));
  const items = Array.isArray(body.items) ? body.items : [];
  return items.flatMap(item => {
    const record = asRecord(item);
    const id = stringField(record, 'id');
    if (!id) return [];
    const aliases = Array.isArray(record?.aliases) ? record.aliases.filter((value): value is string => typeof value === 'string') : [];
    const variants = Array.isArray(record?.variants) ? record.variants.flatMap(variant => {
      const row = asRecord(variant);
      if (!row) return [];
      const params = Array.isArray(row.params) ? row.params.flatMap(param => {
        const parsed = asRecord(param);
        const paramId = stringField(parsed, 'id');
        const value = stringField(parsed, 'value');
        return paramId && value ? [{id: paramId, value}] : [];
      }) : [];
      return [{params, isDefault: row.isDefault === true}];
    }) : [];
    return [{
      id,
      displayName: stringField(record, 'displayName') ?? id,
      description: stringField(record, 'description'),
      aliases,
      variants,
    }];
  });
}

function selectCatalogVariant(model: CursorCatalogModel): CursorModelParam[] | undefined {
  const fast = model.variants.find(variant => variant.params.some(param => param.id === 'fast' && param.value === 'true'));
  const fallback = model.variants.find(variant => variant.isDefault) ?? model.variants[0];
  const chosen = fast ?? fallback;
  return chosen && chosen.params.length > 0 ? chosen.params : undefined;
}

async function resolveCursorModel(apiKey: string, requestedId: string): Promise<{id: string; params?: CursorModelParam[]}> {
  const requested = requestedId.trim() || DEFAULT_MODEL;
  const catalog = await fetchCursorCatalog(apiKey);
  const match = catalog.find(item => item.id === requested || item.aliases.includes(requested));
  if (!match) return {id: requested};
  const params = selectCatalogVariant(match);
  return params ? {id: match.id, params} : {id: match.id};
}

function cursorError(status: number, body: Record<string, unknown>): string {
  const message = stringField(body, 'message') ?? stringField(body, 'error') ?? JSON.stringify(body).slice(0, 240);
  return `Cursor API HTTP ${status}: ${message || 'request failed'}`;
}

function composePlannerPrompt(request: GenerateRequest): string {
  return [
    request.system,
    '',
    'You are generating one Jarvis phone-control action.',
    'Do not browse, edit files, or call tools.',
    'Reply with exactly one JSON object and no markdown.',
    '',
    request.prompt,
  ].join('\n');
}

function promptBody(request: GenerateRequest): Record<string, unknown> {
  const images = request.screenshotBase64
    ? [{data: request.screenshotBase64, mimeType: request.screenshotMediaType ?? 'image/png'}]
    : undefined;
  return {
    text: composePlannerPrompt(request),
    ...(images ? {images} : {}),
  };
}

async function waitForRun(apiKey: string, agentId: string, runId: string, onEvent?: CursorCloudOptions['onEvent']): Promise<string> {
  onEvent?.('cursor_run_poll', 'Waiting for Cursor cloud reply', {agentId, runId});
  const streamed = await streamRun(apiKey, agentId, runId, onEvent).catch(() => null);
  if (streamed) return streamed;
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    const response = await cursorFetch(apiKey, `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`);
    const body = await readJson(response);
    if (!response.ok) throw new Error(cursorError(response.status, body));
    const status = stringField(body, 'status') ?? 'UNKNOWN';
    onEvent?.('cursor_run_poll', `Cursor run ${status}`, {agentId, runId, status});
    if (status === 'FINISHED') {
      const result = stringField(body, 'result');
      if (!result) throw new Error('Cursor run finished without a result');
      return result;
    }
    if (status === 'ERROR' || status === 'CANCELLED' || status === 'EXPIRED') {
      throw new Error(`Cursor run ${status.toLowerCase()}${stringField(body, 'result') ? `: ${stringField(body, 'result')}` : ''}`);
    }
    await delay(400);
  }
  throw new Error('Timed out waiting for Cursor cloud run');
}

async function streamRun(apiKey: string, agentId: string, runId: string, onEvent?: CursorCloudOptions['onEvent']): Promise<string> {
  const response = await cursorFetch(apiKey, `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`, {
    headers: {Accept: 'text/event-stream'},
  });
  if (!response.ok || !response.body) throw new Error(`Cursor stream HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = '';
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const dataLine = chunk.split('\n').find(line => line.startsWith('data:'));
      if (!dataLine) continue;
      const payload = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
      const type = typeof payload.type === 'string' ? payload.type : '';
      if (type === 'assistant' && typeof payload.text === 'string') {
        result += payload.text;
        onEvent?.('cursor_run_poll', 'Cursor is streaming a reply');
      }
      if (type === 'result') {
        const text = typeof payload.text === 'string' ? payload.text : result;
        if (!text) throw new Error('Cursor stream finished without text');
        return text;
      }
      if (type === 'error') {
        throw new Error(typeof payload.message === 'string' ? payload.message : 'Cursor stream error');
      }
    }
  }
  if (!result) throw new Error('Cursor stream ended without a result');
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class CursorCloudLlmRuntime {
  readonly provider = 'cursor';
  private agentId: string | null = null;
  private resolvedModel: {id: string; params?: CursorModelParam[]} | null = null;

  constructor(private readonly options: CursorCloudOptions) {}

  get model(): string {
    return this.options.modelId?.trim() || DEFAULT_MODEL;
  }

  async generate(request: GenerateRequest): Promise<string> {
    this.options.onEvent?.('llm_generate_start', 'Sending planner request to Cursor cloud', {
      provider: this.provider,
      model: this.model,
      promptChars: request.prompt.length,
    });
    const run = this.agentId
      ? await this.followUp(request)
      : await this.createAgent(request);
    const text = await waitForRun(this.options.apiKey, run.agentId, run.id, this.options.onEvent);
    this.options.onEvent?.('llm_generate_result', `Cursor returned ${text.length} chars`, {
      provider: this.provider,
      model: this.model,
      outputPreview: text.slice(0, 400),
    });
    return text;
  }

  private async createAgent(request: GenerateRequest): Promise<{id: string; agentId: string}> {
    const response = await cursorFetch(this.options.apiKey, '/v1/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Jarvis phone planner',
        model: await this.modelPayload(),
        prompt: promptBody(request),
      }),
    });
    const body = await readJson(response);
    if (!response.ok) throw new Error(cursorError(response.status, body));
    const agent = asRecord(body.agent) ?? body;
    const run = asRecord(body.run);
    const agentId = stringField(agent, 'id');
    const runId = stringField(run, 'id') ?? stringField(agent, 'latestRunId');
    if (!agentId || !runId) throw new Error('Cursor create-agent response missing agent or run id');
    this.agentId = agentId;
    this.options.onEvent?.('cursor_agent_created', `Created Cursor cloud agent ${agentId}`, {agentId, runId});
    return {id: runId, agentId};
  }

  private async modelPayload(): Promise<{id: string; params?: CursorModelParam[]}> {
    if (!this.resolvedModel) {
      this.resolvedModel = await resolveCursorModel(this.options.apiKey, this.model);
      this.options.onEvent?.('cursor_model_resolved', `Using Cursor model ${this.resolvedModel.id}`, this.resolvedModel);
    }
    return this.resolvedModel;
  }

  private async followUp(request: GenerateRequest, attempt = 0): Promise<{id: string; agentId: string}> {
    const agentId = this.agentId!;
    const response = await cursorFetch(this.options.apiKey, `/v1/agents/${encodeURIComponent(agentId)}/runs`, {
      method: 'POST',
      body: JSON.stringify({prompt: promptBody(request)}),
    });
    const body = await readJson(response);
    if (response.status === 404) {
      this.agentId = null;
      return this.createAgent(request);
    }
    if (response.status === 409 && attempt < 8) {
      await delay(2500);
      return this.followUp(request, attempt + 1);
    }
    if (!response.ok) {
      this.agentId = null;
      return this.createAgent(request);
    }
    const run = asRecord(body.run) ?? body;
    const runId = stringField(run, 'id');
    if (!runId) throw new Error('Cursor follow-up response missing run id');
    return {id: runId, agentId};
  }
}
