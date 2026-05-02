import { formatErrorMessage } from "../infra/errors.js";

type StartupTaskResult =
  | { status: "skipped"; reason: string }
  | { status: "ran" }
  | { status: "failed"; reason: string };

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
