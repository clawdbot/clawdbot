import { CodexAppServerRpcError } from "./client.js";

export const CODEX_CONTROL_METHODS = {
  account: "account/read",
  compact: "thread/compact/start",
  feedback: "feedback/upload",
  listMcpServers: "mcpServerStatus/list",
  listSkills: "skills/list",
  listThreads: "thread/list",
  rateLimits: "account/rateLimits/read",
  resumeThread: "thread/resume",
  review: "review/start",
} as const;

export type CodexControlName = keyof typeof CODEX_CONTROL_METHODS;
export type CodexControlMethod = (typeof CODEX_CONTROL_METHODS)[CodexControlName];

export function describeControlFailure(error: unknown): string {
  if (isUnsupportedControlError(error)) {
    return "unsupported by this Codex app-server";
  }
  return error instanceof Error ? error.message : String(error);
}

function isUnsupportedControlError(error: unknown): error is CodexAppServerRpcError {
  return error instanceof CodexAppServerRpcError && error.code === -32601;
}
