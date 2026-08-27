/** Runtime facade for compact command dependencies. */
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";

export function isCurrentSessionEntry(params: {
  agentId: string;
  sessionKey: string;
  storePath: string;
  expected: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
}): boolean {
  const current = loadSessionEntryReadOnly(params);
  return (
    current?.sessionId === params.expected.sessionId &&
    current.lifecycleRevision === params.expected.lifecycleRevision
  );
}

export {
  abortEmbeddedAgentRun,
  compactEmbeddedAgentSession,
  isEmbeddedAgentRunAbortableForCompaction,
  waitForEmbeddedAgentRunEnd,
} from "../../agents/embedded-agent.js";
export { resolveFreshSessionTotalTokens } from "../../config/sessions.js";
export { enqueueSystemEvent } from "../../infra/system-events.js";
export { formatContextUsageShort, formatTokenCount } from "../status.js";
export { incrementCompactionCount } from "./session-updates.js";
