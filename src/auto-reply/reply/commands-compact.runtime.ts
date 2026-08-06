/** Runtime facade for compact command dependencies. */
export {
  abortEmbeddedAgentRun,
  compactEmbeddedAgentSession,
  isEmbeddedAgentRunAbortableForCompaction,
  waitForEmbeddedAgentRunEnd,
} from "../../agents/embedded-agent.js";
export {
  resolveFreshSessionTotalTokens,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions.js";
export { enqueueSystemEvent } from "../../infra/system-events.js";
export { formatContextUsageShort, formatTokenCount } from "../status.js";
export { incrementCompactionCount } from "./session-updates.js";
