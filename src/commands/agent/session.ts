// Public command re-export for session key helpers used by CLI and gateway dispatch paths.
export {
  buildExplicitSessionIdSessionKey,
  resolveSessionKeyForRequest,
} from "../../agents/command/session.js";
