import type { AgentEventPayload } from "../infra/agent-events.js";
import type { TrustedToolExecutionEvent } from "../infra/diagnostic-events.js";

export type AgentEventAuditRecorder = {
  record: (event: AgentEventPayload) => void;
  recordTool: (event: TrustedToolExecutionEvent) => void;
  stop: () => Promise<void>;
};
