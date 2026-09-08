import path from "node:path";
import {
  loadRunOverflowCompactionHarness,
  createOverflowRunParams,
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

/** Durable recovery needs a real row; the public lane owner installs its writer claim. */
export async function createSharedRunIntegrationSession(identity?: {
  sessionId: string;
  sessionKey: string;
}) {
  const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
  const { loadSessionEntry, replaceSessionEntry } =
    await import("../../config/sessions/session-accessor.js");
  const { forgetActiveSessionForShutdown } =
    await import("../../gateway/active-sessions-shutdown-tracker.js");
  const state = await createOpenClawTestState({ label: "run-integration-session" });
  const baseRunParams = createOverflowRunParams(state);
  const { sessionId, sessionKey } = identity ?? baseRunParams;
  const sessionTarget = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
  };
  try {
    await replaceSessionEntry(sessionTarget, { sessionId, updatedAt: 1 });
    return {
      runParams: {
        ...baseRunParams,
        sessionId,
        sessionKey,
        sessionTarget,
      },
      cleanup: async () => {
        try {
          forgetActiveSessionForShutdown(sessionId);
          const current = loadSessionEntry({ ...sessionTarget, readConsistency: "latest" });
          if (current) {
            forgetActiveSessionForShutdown(current.sessionId);
          }
        } finally {
          await state.cleanup();
        }
      },
    };
  } catch (error) {
    await state.cleanup();
    throw error;
  }
}
