import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';

export interface AcpPromptResult {
  stopReason: string;
  sessionId: string;
}

/**
 * Optional ACP client: Jarvis is the ACP client, OpenCode is the ACP agent.
 * OpenCode still consumes Jarvis capabilities through MCP, not through ACP.
 */
export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void}>();
  private buffer = '';

  constructor(
    private readonly command: string,
    private readonly args: string[],
  ) {}

  async connect(): Promise<void> {
    if (this.child) return;
    this.child = spawn(this.command, this.args, {stdio: ['pipe', 'pipe', 'pipe']});
    this.child.stdout.on('data', chunk => this.onData(chunk.toString('utf8')));
    this.child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8').trim();
      if (text) console.warn('[acp]', text);
    });
    this.child.on('exit', () => {
      this.child = null;
      for (const [, waiter] of this.pending) waiter.reject(new Error('ACP agent exited'));
      this.pending.clear();
    });

    await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: {name: 'jarvis-gateway', version: '1.0.0'},
      capabilities: {fs: {}, terminal: {}},
    });
  }

  async startSession(input: {cwd: string; mcpCommand: string; mcpArgs: string[]; authHeader?: string}): Promise<string> {
    await this.connect();
    const result = await this.request('session/new', {
      cwd: input.cwd,
      mcpServers: [
        {
          name: 'jarvis',
          command: input.mcpCommand,
          args: input.mcpArgs,
          env: input.authHeader
            ? [{name: 'JARVIS_AUTH_TOKEN', value: input.authHeader.replace(/^Bearer\s+/i, '')}]
            : [],
        },
      ],
    }) as {sessionId?: string};
    if (!result.sessionId) throw new Error('ACP agent did not return sessionId');
    return result.sessionId;
  }

  async prompt(sessionId: string, text: string): Promise<AcpPromptResult> {
    const result = await this.request('session/prompt', {
      sessionId,
      prompt: [{type: 'text', text}],
    }) as {stopReason?: string};
    return {sessionId, stopReason: result.stopReason ?? 'unknown'};
  }

  async close(): Promise<void> {
    this.child?.kill();
    this.child = null;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error('ACP agent is not connected'));
        return;
      }
      this.pending.set(id, {resolve, reject});
      const payload = JSON.stringify({jsonrpc: '2.0', id, method, params});
      this.child.stdin.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.slice(bodyStart, bodyStart + length);
      this.buffer = this.buffer.slice(bodyStart + length);
      this.onMessage(body);
    }
  }

  private onMessage(body: string): void {
    let parsed: {id?: number; result?: unknown; error?: {message?: string}; method?: string};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      return;
    }
    if (parsed.method === 'session/request_permission') {
      // Device-side safety already lives in the Jarvis gateway. Auto-allow ACP UI permission prompts.
      if (typeof parsed.id === 'number' && this.child) {
        const payload = JSON.stringify({jsonrpc: '2.0', id: parsed.id, result: {outcome: {outcome: 'selected', optionId: 'allow-once'}}});
        this.child.stdin.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
      }
      return;
    }
    if (typeof parsed.id !== 'number') return;
    const waiter = this.pending.get(parsed.id);
    if (!waiter) return;
    this.pending.delete(parsed.id);
    if (parsed.error) waiter.reject(new Error(parsed.error.message ?? 'ACP error'));
    else waiter.resolve(parsed.result);
  }
}

export function createOpenCodeAcpClient(): AcpClient {
  return new AcpClient('opencode', ['acp']);
}
