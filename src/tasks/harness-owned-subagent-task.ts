import type { TaskRecord } from "./task-registry.types.js";

// Harness-mirrored subagents (Codex/Copilot native threads) have no OpenClaw child session, so
// they cannot be recovered or cancelled through one. Both halves of the test are load-bearing:
// OpenClaw-owned rows always carry childSessionKey, and only the agent-harness task runtime stamps
// taskKind on a subagent row (required there by type, so ownership cannot be forgotten). Deliberately
// generic — core must not learn plugin ids or run-id prefixes to classify its own registry.
export function isHarnessOwnedSubagentTask(task: TaskRecord): boolean {
  return (
    task.runtime === "subagent" && !task.childSessionKey?.trim() && Boolean(task.taskKind?.trim())
  );
}
