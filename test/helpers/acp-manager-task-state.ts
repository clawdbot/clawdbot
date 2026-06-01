import { resetTaskFlowRegistryForTests } from "../../src/tasks/task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "../../src/tasks/task-flow-registry.store.js";
import { findTaskByRunId, resetTaskRegistryForTests } from "../../src/tasks/task-registry.js";
import { withTempDir } from "../../src/test-helpers/temp-dir.js";
import { installInMemoryTaskRegistryRuntime } from "../../src/test-utils/task-registry-runtime.js";

export { findTaskByRunId };

export function resetAcpManagerTaskStateForTests(): void {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
}

export async function withAcpManagerTaskStateDir(
  run: (root: string) => Promise<void>,
): Promise<void> {
  await withTempDir({ prefix: "openclaw-acp-manager-task-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetAcpManagerTaskStateForTests();
    installInMemoryTaskRegistryRuntime();
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          flows: new Map(),
        }),
        saveSnapshot: () => {},
        upsertFlow: () => {},
        deleteFlow: () => {},
        close: () => {},
      },
    });
    try {
      await run(root);
    } finally {
      resetAcpManagerTaskStateForTests();
    }
  });
}

export function requireTaskByRunId(runId: string) {
  const task = findTaskByRunId(runId);
  if (!task) {
    throw new Error(`Expected task for run ${runId}`);
  }
  return task;
}
