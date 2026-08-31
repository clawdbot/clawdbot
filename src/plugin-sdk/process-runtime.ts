// Public process helpers for plugins that spawn or probe local commands.

export {
  type CommandOptions,
  resolveCommandEnv,
  resolveProcessExitCode,
  runCommandBuffered,
  runCommandWithTimeout,
  runExec,
  shouldSpawnWithShell,
  type SpawnResult,
} from "../process/exec.js";
export { prepareOomScoreAdjustedSpawn } from "../process/linux-oom-score.js";
export type { OomScoreAdjustedSpawn, OomWrapOptions } from "../process/linux-oom-score.js";
export { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
export { killProcessTree } from "../process/kill-tree.js";
export { isPidAlive } from "../shared/pid-alive.js";
export { prepareSecretInputStdio, type SpawnStdioEntry } from "../process/spawn-secret-input.js";
