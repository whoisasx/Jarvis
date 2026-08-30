import {stdin, stdout} from 'node:process';

const gatewayUrl = process.env.JARVIS_GATEWAY_URL ?? 'http://127.0.0.1:3000/mcp';
const authToken = process.env.JARVIS_AUTH_TOKEN ?? process.env.PHONE_AUTH_TOKEN ?? '';

if (!authToken.trim()) {
  console.error(
    'Jarvis stdio MCP requires JARVIS_AUTH_TOKEN or PHONE_AUTH_TOKEN. ' +
    `Forwarding to ${gatewayUrl}. Example: JARVIS_AUTH_TOKEN=... JARVIS_GATEWAY_URL=http://127.0.0.1:3000/mcp npm run mcp`,
  );
  process.exit(1);
}

let buffer = '';
stdin.setEncoding('utf8');
stdin.on('data', chunk => {
  buffer += chunk;
  buffer = drain(buffer);
});

function drain(current: string): string {
  while (true) {
    const headerEnd = current.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      const newline = current.indexOf('\n');
      if (newline >= 0 && !current.startsWith('Content-Length:')) {
        const line = current.slice(0, newline).trim();
        current = current.slice(newline + 1);
        if (line) void forward(line, false);
        continue;
      }
      return current;
    }
    const header = current.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) return current.slice(headerEnd + 4);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (current.length < bodyStart + length) return current;
    const body = current.slice(bodyStart, bodyStart + length);
    current = current.slice(bodyStart + length);
    void forward(body, true);
  }
}

async function forward(body: string, lspFraming: boolean): Promise<void> {
  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authToken ? {authorization: `Bearer ${authToken}`} : {}),
    },
    body,
  });
  const payload = await response.text();
  if (lspFraming) {
    stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
  } else {
    stdout.write(`${payload}\n`);
  }
}
