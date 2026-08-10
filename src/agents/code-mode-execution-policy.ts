import type { CodeModeOwnedActivityContext } from "./code-mode-activity.js";
import type { CodeModeConfig, PendingBridgeRequest } from "./code-mode-runtime.js";
import type { ToolSearchToolContext } from "./tool-search.js";

export type CodeModeToolContext = ToolSearchToolContext & CodeModeOwnedActivityContext;

const RESTART_RECOVERY_AGENT_SPAWN_ERROR =
  "restart recovery cannot resume agents.run: cold recovery cannot reattach its prior collector and must not launch a new one.";

export function restartRecoveryRejectedRequestError(
  pendingRequests: readonly PendingBridgeRequest[],
): string {
  return pendingRequests.some((request) => request.method === "agentSpawn")
    ? RESTART_RECOVERY_AGENT_SPAWN_ERROR
    : "restart-safe code mode cannot call side-effecting tools.";
}

export function usableCodeModeResumeBudgetMs(
  deadlineMs: number,
  config: CodeModeConfig,
): number | undefined {
  const minimum = Math.min(250, Math.max(1, Math.floor(config.timeoutMs / 2)));
  const remaining = deadlineMs - Date.now();
  return remaining >= minimum ? remaining : undefined;
}
