import {
  loadRunOverflowCompactionHarness,
  warmRunOverflowCompactionHarness,
  type TestRunEmbeddedAgent,
} from "./run.overflow-compaction.harness.js";
import { guardRunWorkspaceOwnership } from "./run.workspace-ownership.test-support.js";

let sharedRunEmbeddedAgent: Promise<TestRunEmbeddedAgent> | undefined;

/**
 * These scenarios intentionally cross several runner owners. Load the mocked
 * public entrypoint once so independent assertions do not repeatedly rebuild
 * the same production module graph.
 */
export function loadSharedRunIntegrationHarness(): Promise<TestRunEmbeddedAgent> {
  sharedRunEmbeddedAgent ??= (async () => {
    const { runEmbeddedAgent } = await loadRunOverflowCompactionHarness();
    const { withOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    await withOpenClawTestState({ label: "shared-run-warmup" }, async (state) => {
      const guard = await guardRunWorkspaceOwnership(state);
      try {
        await warmRunOverflowCompactionHarness(runEmbeddedAgent, state);
      } finally {
        guard.verifyAndRestore();
      }
    });
    return runEmbeddedAgent;
  })();
  return sharedRunEmbeddedAgent;
}
