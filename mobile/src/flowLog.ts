import {JarvisDevice} from './native';

const SECRET_PATTERN = /(api[_-]?key|token|authorization|bearer)\s*[:=]\s*[^\s"']+/gi;

export interface FlowTrace {
  ts: number;
  flowId: string;
  taskId: string;
  step: string;
  phase: 'start' | 'success' | 'fail';
  detail: string;
  error?: string;
  stack?: string;
}

function redact(value: string): string {
  return value.replace(SECRET_PATTERN, '$1=***').replace(/cursor_[a-z0-9]{16,}/gi, '***').slice(0, 4000);
}

export function newFlowId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function persistFlowTrace(entry: FlowTrace): void {
  const payload = {
    ...entry,
    detail: redact(entry.detail),
    error: entry.error ? redact(entry.error) : undefined,
    stack: entry.stack ? redact(entry.stack).slice(0, 2500) : undefined,
  };
  JarvisDevice.appendFlowLog(JSON.stringify(payload)).catch(() => undefined);
}

export function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}
