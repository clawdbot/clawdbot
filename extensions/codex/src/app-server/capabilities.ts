/**
 * Capability helpers for optional Codex app-server control-plane methods.
 */
import { CodexAppServerRpcError } from "./client.js";

/** Known app-server methods used by OpenClaw control surfaces. */
export const CODEX_CONTROL_METHODS = {
  account: "account/read",
  installedApps: "app/installed",
  listApps: "app/list",
  readApps: "app/read",
  feedback: "feedback/upload",
  forkThread: "thread/fork",
  listHooks: "hooks/list",
  listMcpServers: "mcpServerStatus/list",
  listPlugins: "plugin/list",
  listSkills: "skills/list",
  listThreads: "thread/list",
  listThreadTurns: "thread/turns/list",
  listThreadItems: "thread/items/list",
  readThread: "thread/read",
  rateLimits: "account/rateLimits/read",
  archiveThread: "thread/archive",
  renameThread: "thread/name/set",
  resumeThread: "thread/resume",
  review: "review/start",
  installPlugin: "plugin/install",
  reloadMcpServers: "config/mcpServer/reload",
  unarchiveThread: "thread/unarchive",
  getThreadGoal: "thread/goal/get",
  setThreadGoal: "thread/goal/set",
  clearThreadGoal: "thread/goal/clear",
} as const;

type CodexControlName = keyof typeof CODEX_CONTROL_METHODS;
/** App-server method name from the known control method map. */
export type CodexControlMethod = (typeof CODEX_CONTROL_METHODS)[CodexControlName];

/** Formats unsupported control calls differently from ordinary RPC failures. */
export function describeControlFailure(error: unknown): string {
  if (isUnsupportedControlError(error)) {
    return "unsupported by this Codex app-server";
  }
  return error instanceof Error ? error.message : String(error);
}

function isUnsupportedControlError(error: unknown): error is CodexAppServerRpcError {
  return error instanceof CodexAppServerRpcError && error.code === -32601;
}
