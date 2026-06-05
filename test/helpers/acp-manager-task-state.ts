// ACP manager task state helper resets task flow state for ACP tests.
import { resetTaskFlowRegistryForTests } from "../../src/tasks/task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "../../src/tasks/task-flow-registry.store.js";
import { findTaskByRunId, resetTaskRegistryForTests } from "../../src/tasks/task-registry.js";
import { withTempDir } from "../../src/test-helpers/temp-dir.js";
import { installInMemoryTaskRegistryRuntime } from "../../src/test-utils/task-registry-runtime.js";

// Shared ACP manager task registry setup for tests.

export { findTaskByRunId };

/** Reset task and task-flow registries without persisting state. */
export function resetAcpManagerTaskStateForTests(): void {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
}

/** Run a test with isolated ACP manager task state rooted in a temp dir. */
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

/** Return a task by run id or fail the test with a clear message. */
export function requireTaskByRunId(runId: string) {
  const task = findTaskByRunId(runId);
  if (!task) {
    throw new Error(`Expected task for run ${runId}`);
  }
  return task;
}
