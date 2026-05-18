// Private helper surface for the bundled Codex plugin. This is intentionally
// local-only so Codex can mirror app-server native subagents into OpenClaw's
// task registry without promoting detached task mutation helpers to the public
// plugin SDK.

export {
  CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
  CODEX_NATIVE_SUBAGENT_RUNTIME,
  CODEX_NATIVE_SUBAGENT_STALE_ERROR,
  CODEX_NATIVE_SUBAGENT_TASK_KIND,
} from "../tasks/codex-native-subagent-task.js";

export {
  createRunningTaskRun,
  finalizeTaskRunByRunId,
  recordTaskRunProgressByRunId,
} from "../tasks/detached-task-runtime.js";
