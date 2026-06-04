/**
 * Runtime dependency barrel for subagent announcement/output collection.
 *
 * Keeping these imports behind one module lets tests replace gateway/session
 * IO without changing the announce logic itself.
 */
export { getRuntimeConfig } from "../config/config.js";
export {
  loadSessionStore,
  readSessionEntry,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
export { callGateway } from "../gateway/call.js";
export { readSessionMessagesAsync } from "../gateway/session-utils.fs.js";
export { dispatchGatewayMethodInProcess } from "../gateway/server-plugins.js";
export {
  isEmbeddedAgentRunActive,
  waitForEmbeddedAgentRunEnd,
} from "./embedded-agent-runner/runs.js";
