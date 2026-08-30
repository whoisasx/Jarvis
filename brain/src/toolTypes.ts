import {ElementMetadata} from './observation.js';

export interface ToolRequest {
  requestId: string;
  sessionId: string;
  capability: string;
  arguments: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  confirmSensitive?: boolean;
}

export interface ToolError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ToolObservation {
  currentApp: string;
  currentAppLabel?: string;
  screen: string;
  summary: string;
  visibleElements: ElementMetadata[];
  clickableCount?: number;
  editableCount?: number;
  scrollable?: boolean;
  lastActionResult?: string | null;
  screenLocked?: boolean;
  batteryPercent?: number | null;
  nodeCount?: number;
  treeAvailable?: boolean;
  observationReason?: string | null;
  observationFresh?: boolean;
  learnedPlaybook?: {
    goal: string;
    score: number;
    why: string;
    apps: string[];
    steps: Array<{capability: string; args?: Record<string, unknown>; note?: string}>;
    pitfalls: string[];
  };
}

export interface ToolResponse {
  requestId: string;
  sessionId: string;
  capability: string;
  success: boolean;
  result?: unknown;
  observation?: ToolObservation;
  error?: ToolError;
}

export interface AgentSessionSnapshot {
  sessionId: string;
  agentName: string;
  protocol: 'http' | 'mcp' | 'acp';
  createdAt: number;
  lastRequestId: string | null;
  lastCapability: string | null;
  lastSuccess: boolean | null;
  lastObservationSummary: string | null;
  goal: string | null;
  status: 'idle' | 'waiting_for_agent' | 'executing' | 'completed' | 'failed';
}

export type OrchestrationMode = 'external' | 'legacy';
