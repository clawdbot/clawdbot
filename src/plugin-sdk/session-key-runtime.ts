// Narrow session-key helpers for channel hot paths that should not import the
// broader routing SDK barrel.
export {
  resolveAgentIdFromSessionKey,
  type ParsedAgentSessionKey,
} from "../routing/session-key.js";
