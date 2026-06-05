// Ordered Gateway startup task runner.
// Used for best-effort side effects that should not abort the server.
import { formatErrorMessage } from "../infra/errors.js";

// Startup tasks run sequentially so logs and side effects stay ordered during
// gateway startup. Failures are collected and logged without aborting later
// tasks.
type StartupTaskResult =
  | { status: "skipped"; reason: string }
  | { status: "ran" }
  | { status: "failed"; reason: string };

/** Startup task descriptor used by gateway startup side-effect runners. */
export type StartupTask = {
  source: string;
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  run: () => Promise<StartupTaskResult>;
};

type StartupTaskLogger = {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

function taskMeta(task: StartupTask, result?: StartupTaskResult): Record<string, unknown> {
  return {
    source: task.source,
    ...(task.agentId ? { agentId: task.agentId } : {}),
    ...(task.sessionKey ? { sessionKey: task.sessionKey } : {}),
    ...(task.workspaceDir ? { workspaceDir: task.workspaceDir } : {}),
    ...(result?.status === "failed" || result?.status === "skipped"
      ? { reason: result.reason }
      : {}),
  };
}

/** Runs startup tasks in order and logs failed/skipped task metadata. */
export async function runStartupTasks(params: {
  tasks: StartupTask[];
  log: StartupTaskLogger;
}): Promise<StartupTaskResult[]> {
  const results: StartupTaskResult[] = [];
  for (const task of params.tasks) {
    let result: StartupTaskResult;
    try {
      result = await task.run();
    } catch (err) {
      result = { status: "failed", reason: formatErrorMessage(err) };
    }
    results.push(result);
    if (result.status === "failed") {
      params.log.warn("startup task failed", taskMeta(task, result));
      continue;
    }
    if (result.status === "skipped") {
      params.log.debug("startup task skipped", taskMeta(task, result));
    }
  }
  return results;
}
