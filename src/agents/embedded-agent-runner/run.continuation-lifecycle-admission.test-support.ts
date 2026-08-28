import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  replaceSessionEntry,
  rollbackAgentHarnessSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../../sessions/agent-harness-session-key.js";
import { expectMockCallFields } from "./run.continuation-fixture.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent lifecycle admission composition", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetAgentEventsForTest();
    resetRunOverflowCompactionHarnessMocks();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
  });

  it("keeps an explicitly captured lifecycle generation across the embedded attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    const lifecycleGeneration = getAgentEventLifecycleGeneration();

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-before-restart",
      lifecycleGeneration,
    });

    expectMockCallFields(mockedRunEmbeddedAttempt, {
      lifecycleGeneration,
    });
  });

  it("revalidates reserved harness ownership after the global queue wait", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-admission-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "native-session";
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    const initialEntry = {
      agentHarnessId: "codex",
      delivery: { kind: "none" } as const,
      modelSelectionLocked: true,
      sessionId,
      updatedAt: Date.now(),
    };
    await replaceSessionEntry({ sessionKey, storePath }, initialEntry);

    let enqueueCount = 0;
    let runQueuedTask: (() => void) | undefined;
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName) => hookName === "before_model_resolve",
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    try {
      const runPromise = runEmbeddedAgent({
        ...overflowBaseRunParams,
        agentHarnessId: "codex",
        config: { session: { store: storePath } } as RunEmbeddedAgentParams["config"],
        modelSelectionLocked: true,
        runId: "queued-harness-admission",
        sessionId,
        sessionKey,
        sessionTarget: { agentId: "main", sessionId, sessionKey, storePath },
        enqueue: async (task) => {
          enqueueCount += 1;
          if (enqueueCount === 1) {
            return await task();
          }
          return await new Promise((resolve, reject) => {
            runQueuedTask = () => {
              void Promise.resolve().then(task).then(resolve, reject);
            };
          });
        },
      });
      await vi.waitFor(() => expect(runQueuedTask).toBeTypeOf("function"));

      await rollbackAgentHarnessSessionEntryLifecycle({
        agentId: "main",
        archiveTranscript: false,
        expectedEntry: initialEntry,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      runQueuedTask?.();

      await expect(runPromise).rejects.toThrow(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
      expect(mockedGlobalHookRunner.runBeforeModelResolve).not.toHaveBeenCalled();
      expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
