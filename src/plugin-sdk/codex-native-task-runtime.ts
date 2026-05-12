// Private helper surface for the bundled Codex plugin. This is intentionally
// local-only so Codex can mirror app-server native subagents into OpenClaw's
// task registry without promoting detached task mutation helpers to the public
// plugin SDK.

export {
  createRunningTaskRun,
  finalizeTaskRunByRunId,
  recordTaskRunProgressByRunId,
} from "../tasks/detached-task-runtime.js";
