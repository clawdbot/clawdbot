// Full session-store resolution for gateway CLI requests that need local routing facts.
import { resolveSessionKeyForRequestCore as resolveAgentSessionKeyForRequest } from "../../agents/command/session.js";

export function resolveSessionKeyForRequest(
  ...args: Parameters<typeof resolveAgentSessionKeyForRequest>
): ReturnType<typeof resolveAgentSessionKeyForRequest> {
  return resolveAgentSessionKeyForRequest(...args);
}
