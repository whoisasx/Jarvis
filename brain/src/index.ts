import 'dotenv/config';
import {createServer} from 'node:http';
import {URL} from 'node:url';
import type WebSocket from 'ws';
import {WebSocketServer} from 'ws';
import {handleMcpRequest} from './adapters/mcpAdapter.js';
import {CloudLlmRuntime, LocalLlmRuntime, OpenAILlmRuntime, type LlmRuntime} from './llmRuntime.js';
import {installNodeFileLogger} from './nodeLogger.js';
import {createNodeProcedureStore} from './nodeProcedureStore.js';
import type {PhoneTransport} from './phoneTransport.js';
import {phoneMessageSchema} from './protocol.js';
import {BrainRuntime} from './runtime.js';

export type LlmProvider = 'gemini' | 'anthropic' | 'openai' | 'local';

const port = Number(process.env.PORT ?? 3000);

const provider: LlmProvider = (() => {
  const val = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (val === 'gemini') return 'gemini';
  if (val === 'openai') return 'openai';
  if (val === 'local') return 'local';
  return 'anthropic';
})();

const authToken = process.env.PHONE_AUTH_TOKEN;

function createLlm(): LlmRuntime {
  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    if (!apiKey || !authToken) throw new Error('OPENAI_API_KEY and PHONE_AUTH_TOKEN are required');
    return new OpenAILlmRuntime(apiKey, model);
  }
  if (provider === 'local') {
    const model = process.env.LOCAL_MODEL ?? 'deepseek-coder';
    return new LocalLlmRuntime(model);
  }
  const apiKey = provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.ANTHROPIC_API_KEY;
  const model = provider === 'gemini'
    ? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
    : process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
  if (!apiKey || !authToken) {
    throw new Error(`${provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'} and PHONE_AUTH_TOKEN are required`);
  }
  return new CloudLlmRuntime(provider, apiKey, model);
}

installNodeFileLogger();

const llm = createLlm();
const brain = new BrainRuntime({
  llm,
  procedureStore: createNodeProcedureStore(),
});
brain.start();

class WebSocketPhoneTransport implements PhoneTransport {
  constructor(private readonly socket: WebSocket) {}

  isConnected(): boolean {
    return this.socket.readyState === this.socket.OPEN;
  }

  send(message: Parameters<PhoneTransport['send']>[0]): void {
    this.socket.send(JSON.stringify(message));
  }

  onClose(listener: () => void): void {
    this.socket.on('close', listener);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }
}

function bearerToken(value: string | undefined): string | null {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function isAuthorized(header: string | undefined, url: URL): boolean {
  return bearerToken(header) === authToken || url.searchParams.get('token') === authToken;
}

function sendJson(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8'});
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const server = createServer(async (request, response) => {
  try {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/health') {
    const status = brain.getStatus();
    sendJson(response, 200, {
      ok: true,
      provider: llm.provider,
      model: llm.model,
      phoneConnected: status.phoneConnected,
      activeTask: status.activeTask?.id ?? null,
      workingMemory: status.workingMemory,
      worldState: status.worldState,
      lastPlannerContext: status.lastPlannerContext,
      recentEvents: status.recentEvents,
      memoryCandidates: status.memoryCandidates,
      goals: status.goals,
      orchestration: status.orchestration,
      gateway: status.gateway,
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/tools') {
    if (!isAuthorized(request.headers.authorization, url)) {
      sendJson(response, 401, {error: 'Unauthorized'});
      return;
    }
    sendJson(response, 200, {tools: brain.gateway.listTools()});
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/gateway') {
    if (!isAuthorized(request.headers.authorization, url)) {
      sendJson(response, 401, {error: 'Unauthorized'});
      return;
    }
    sendJson(response, 200, brain.gateway.status());
    return;
  }

  const body = request.method === 'POST' ? await readJsonBody(request) : null;

  if (request.method === 'POST' && url.pathname === '/v1/sessions') {
    if (!isAuthorized(request.headers.authorization, url)) {
      sendJson(response, 401, {error: 'Unauthorized'});
      return;
    }
    const payload = (body ?? {}) as {agentName?: unknown; goal?: unknown};
    const session = brain.gateway.createSession({
      agentName: typeof payload.agentName === 'string' ? payload.agentName : 'http-agent',
      protocol: 'http',
      goal: typeof payload.goal === 'string' ? payload.goal : undefined,
    });
    sendJson(response, 201, session);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/tools/invoke') {
    if (!isAuthorized(request.headers.authorization, url)) {
      sendJson(response, 401, {error: 'Unauthorized'});
      return;
    }
    try {
      const payload = (body ?? {}) as Record<string, unknown>;
      const result = await brain.gateway.invoke({
        sessionId: String(payload.sessionId ?? 'http-anonymous'),
        capability: String(payload.capability ?? ''),
        arguments: asRecord(payload.arguments),
        confirmSensitive: payload.confirmSensitive === true,
        protocol: 'http',
        agentName: typeof payload.agentName === 'string' ? payload.agentName : 'http-agent',
      });
      sendJson(response, result.success ? 200 : 409, result);
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/mcp') {
    if (!isAuthorized(request.headers.authorization, url)) {
      sendJson(response, 401, {error: 'Unauthorized'});
      return;
    }
    const sessionId = String(url.searchParams.get('sessionId') ?? request.headers['x-jarvis-session'] ?? 'mcp-http');
    const rpc = await handleMcpRequest(brain.gateway, (body ?? {}) as {id?: string | number | null; method?: string; params?: unknown}, sessionId);
    sendJson(response, 200, rpc);
    return;
  }

  if (request.method !== 'POST' || url.pathname !== '/task') {
    sendJson(response, 404, {error: 'Not found'});
    return;
  }
  if (!isAuthorized(request.headers.authorization, url)) {
    sendJson(response, 401, {error: 'Unauthorized'});
    return;
  }

  try {
    const payload = (body ?? {}) as {instruction?: unknown};
    if (typeof payload.instruction !== 'string' || !payload.instruction.trim()) {
      sendJson(response, 400, {error: 'instruction must be a non-empty string'});
      return;
    }
    const taskId = await brain.submitTask(payload.instruction.trim());
    sendJson(response, 202, {taskId, status: 'accepted', orchestration: brain.getStatus().orchestration});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('already active') ? 409 : message.includes('not connected') ? 503 : 400;
    sendJson(response, status, {error: message});
  }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /json|unexpected token/i.test(message) ? 400 : 500;
    if (!response.headersSent) sendJson(response, status, {error: message});
  }
});

const webSockets = new WebSocketServer({noServer: true, maxPayload: 12 * 1024 * 1024});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/phone' || !isAuthorized(request.headers.authorization, url)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  webSockets.handleUpgrade(request, socket, head, phone => webSockets.emit('connection', phone, request));
});

webSockets.on('connection', phone => {
  brain.attachPhone(new WebSocketPhoneTransport(phone));
  phone.send(JSON.stringify({type: 'task_status', status: 'connected'}));

  phone.on('message', async raw => {
    try {
      const parsed = JSON.parse(raw.toString());
      const message = phoneMessageSchema.parse(parsed);
      await brain.receivePhoneMessage(message);
    } catch (error) {
      const rawObject = (() => {
        try {
          return JSON.parse(raw.toString()) as {type?: string; nodeTree?: unknown[]};
        } catch {
          return null;
        }
      })();
      if (rawObject?.type === 'screen_state' && Array.isArray(rawObject.nodeTree)) {
        const sanitized = {
          ...rawObject,
          nodeTree: rawObject.nodeTree.filter(node => {
            if (!node || typeof node !== 'object') return false;
            const bounds = (node as {bounds?: unknown}).bounds;
            return Array.isArray(bounds) && bounds.length >= 4 && bounds.every(value => typeof value === 'number');
          }),
        };
        try {
          await brain.receivePhoneMessage(phoneMessageSchema.parse(sanitized));
          return;
        } catch {
          // fall through
        }
      }
      const detail = error instanceof Error ? error.message : String(error);
      phone.send(JSON.stringify({type: 'task_status', status: 'invalid_message', detail}));
    }
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Jarvis brain listening on http://0.0.0.0:${port} using ${llm.provider}/${llm.model}`);
});
