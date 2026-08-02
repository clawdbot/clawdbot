import {
  loadRunOverflowCompactionHarness,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";

type RunEmbeddedAgent = typeof import("./run.js").runEmbeddedAgent;

let sharedRunEmbeddedAgent: Promise<RunEmbeddedAgent> | undefined;

/**
 * These scenarios intentionally cross several runner owners. Load the mocked
 * public entrypoint once so independent assertions do not repeatedly rebuild
 * the same production module graph.
 */
export function loadSharedRunIntegrationHarness(): Promise<RunEmbeddedAgent> {
  sharedRunEmbeddedAgent ??= (async () => {
    const { runEmbeddedAgent } = await loadRunOverflowCompactionHarness();
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
    return runEmbeddedAgent;
  })();
  return sharedRunEmbeddedAgent;
}
