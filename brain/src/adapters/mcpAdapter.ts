import {AgentGateway} from '../gateway.js';
import type {ToolResponse} from '../toolTypes.js';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export function mcpTools(gateway: AgentGateway) {
  return gateway.listTools().map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export async function handleMcpRequest(gateway: AgentGateway, request: JsonRpcRequest, sessionId: string): Promise<Record<string, unknown>> {
  const id = request.id ?? null;
  try {
    switch (request.method) {
      case 'initialize':
        return result(id, {
          protocolVersion: '2024-11-05',
          capabilities: {tools: {listChanged: false}},
          serverInfo: {name: 'jarvis-gateway', version: '1.0.0'},
          instructions: 'Jarvis is an Android execution platform. You own planning and the agent loop. Call Jarvis tools to act on the phone, then decide the next step from the observation.',
        });
      case 'notifications/initialized':
      case 'initialized':
        return {jsonrpc: '2.0', id, result: {}};
      case 'ping':
        return result(id, {});
      case 'tools/list':
        return result(id, {tools: mcpTools(gateway)});
      case 'tools/call': {
        const params = asRecord(request.params);
        const name = String(params.name ?? '');
        const args = asRecord(params.arguments);
        const response = await gateway.invoke({
          sessionId,
          capability: name,
          arguments: args,
          confirmSensitive: args.confirmSensitive === true,
          protocol: 'mcp',
          agentName: 'mcp-client',
        });
        return result(id, mcpToolResult(response));
      }
      default:
        return error(id, -32601, `Method not found: ${request.method ?? 'unknown'}`);
    }
  } catch (err) {
    return error(id, -32603, err instanceof Error ? err.message : String(err));
  }
}

export function mcpToolResult(response: ToolResponse) {
  return {
    content: [{type: 'text', text: JSON.stringify(response, null, 2)}],
    isError: !response.success,
    structuredContent: response,
  };
}

function result(id: string | number | null, value: unknown): Record<string, unknown> {
  return {jsonrpc: '2.0', id, result: value};
}

function error(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return {jsonrpc: '2.0', id, error: {code, message}};
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
