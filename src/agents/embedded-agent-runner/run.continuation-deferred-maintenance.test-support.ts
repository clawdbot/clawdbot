import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { waitForRunEvent } from "./run.continuation-fixture.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedRunEmbeddedAttempt,
  mockedWaitForDeferredTurnMaintenanceForSession,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent deferred maintenance composition", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetAgentEventsForTest();
    resetRunOverflowCompactionHarnessMocks();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "ok" }]);
  });

  it("waits for same-session deferred maintenance before the attempt reads session state", async () => {
    const events: string[] = [];
    mockedWaitForDeferredTurnMaintenanceForSession.mockImplementationOnce(async (sessionKey) => {
      events.push(`wait:${sessionKey}`);
    });
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
      events.push("attempt");
      return makeAttemptResult({ promptError: null });
    });

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-wait-deferred-maintenance",
      sessionKey: "agent:main:session-wait-deferred-maintenance",
    });

    expect(events).toEqual(["wait:agent:main:session-wait-deferred-maintenance", "attempt"]);
  });

  it("does not hold the global run lane while waiting for another session's deferred maintenance", async () => {
    const events: string[] = [];
    let releaseSessionA: (() => void) | undefined;
    mockedWaitForDeferredTurnMaintenanceForSession.mockImplementation(async (sessionKey) => {
      events.push(`wait:${sessionKey}`);
      if (sessionKey !== "agent:main:session-a") {
        return;
      }
      await new Promise<void>((resolve) => {
        releaseSessionA = resolve;
      });
    });
    mockedRunEmbeddedAttempt.mockImplementation(async (params) => {
      events.push(`attempt:${(params as { sessionKey?: string }).sessionKey}`);
      return makeAttemptResult({ promptError: null });
    });

    const sessionARun = runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-deferred-maintenance-session-a",
      sessionKey: "agent:main:session-a",
    });
    await waitForRunEvent(events, "wait:agent:main:session-a");

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-deferred-maintenance-session-b",
      sessionKey: "agent:main:session-b",
    });

    expect(events).toEqual([
      "wait:agent:main:session-a",
      "wait:agent:main:session-b",
      "attempt:agent:main:session-b",
    ]);
    if (!releaseSessionA) {
      throw new Error("Expected session A maintenance release callback to be initialized");
    }
    releaseSessionA();
    await sessionARun;
    expect(events).toEqual([
      "wait:agent:main:session-a",
      "wait:agent:main:session-b",
      "attempt:agent:main:session-b",
      "attempt:agent:main:session-a",
    ]);
  });
});
