import { isPlainObject } from "../utils.js";

export function isKnownPollToolCall(toolName: string, params: unknown): boolean {
  if (toolName === "command_status") {
    return true;
  }
  if (toolName !== "process" || !isPlainObject(params)) {
    return false;
  }
  const action = params.action;
  return action === "poll" || action === "log";
}
