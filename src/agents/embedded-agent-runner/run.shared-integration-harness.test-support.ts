import {
  loadRunOverflowCompactionHarness,
  warmRunOverflowCompactionHarness,
  type TestRunEmbeddedAgent,
} from "./run.overflow-compaction.harness.js";

let sharedRunEmbeddedAgent: Promise<TestRunEmbeddedAgent> | undefined;

/**
 * These scenarios intentionally cross several runner owners. Load the mocked
 * public entrypoint once so independent assertions do not repeatedly rebuild
 * the same production module graph.
 */
export function loadSharedRunIntegrationHarness(): Promise<TestRunEmbeddedAgent> {
  sharedRunEmbeddedAgent ??= (async () => {
    const { runEmbeddedAgent } = await loadRunOverflowCompactionHarness();
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
    return runEmbeddedAgent;
  })();
  return sharedRunEmbeddedAgent;
}
