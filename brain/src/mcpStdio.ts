import {stdin, stdout} from 'node:process';
import {handleMcpRequest} from './adapters/mcpAdapter.js';

export function startMcpStdio(gateway: {invoke: Function; listTools: Function}) {
  let buffer = '';
  stdin.setEncoding('utf8');
  stdin.on('data', chunk => {
    buffer += chunk;
    buffer = drain(buffer, gateway);
  });
}

function drain(buffer: string, gateway: {invoke: Function; listTools: Function}): string {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      const newline = buffer.indexOf('\n');
      if (newline >= 0 && !buffer.startsWith('Content-Length:')) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) void respondNdjson(line, gateway);
        continue;
      }
      return buffer;
    }
    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) return buffer.slice(headerEnd + 4);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return buffer;
    const body = buffer.slice(bodyStart, bodyStart + length);
    buffer = buffer.slice(bodyStart + length);
    void respond(body, gateway, true);
  }
}

async function respondNdjson(line: string, gateway: {invoke: Function; listTools: Function}): Promise<void> {
  await respond(line, gateway, false);
}

async function respond(body: string, gateway: {invoke: Function; listTools: Function}, lspFraming: boolean): Promise<void> {
  let request: {id?: string | number | null; method?: string; params?: unknown};
  try {
    request = JSON.parse(body) as typeof request;
  } catch {
    return;
  }
  const sessionId = process.env.JARVIS_SESSION_ID || 'mcp-stdio';
  const response = await handleMcpRequest(gateway as never, request, sessionId);
  const payload = JSON.stringify(response);
  if (lspFraming) {
    stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
  } else {
    stdout.write(`${payload}\n`);
  }
}
