// Public process helpers for plugins that spawn or probe local commands.

export { splitCommandArgs } from "../utils/shell-argv.js";
export {
  type CommandOptions,
  resolveCommandEnv,
  resolveProcessExitCode,
  runCommandBuffered,
  runCommandWithTimeout,
  runUtf8CommandWithTimeout,
  runExec,
  shouldSpawnWithShell,
  type SpawnResult,
} from "../process/exec.js";
export { prepareOomScoreAdjustedSpawn } from "../process/linux-oom-score.js";
export type { OomScoreAdjustedSpawn, OomWrapOptions } from "../process/linux-oom-score.js";
export { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
export { WorkerTaskPool, serveWorkerTasks } from "../infra/worker-task-pool.js";
export { killProcessTree, signalProcessTree } from "../process/kill-tree.js";
export {
  getFileLockProcessStartTime,
  isPidAlive,
  isPidDefinitelyDead,
} from "../shared/pid-alive.js";
export { prepareSecretInputStdio, type SpawnStdioEntry } from "../process/spawn-secret-input.js";
