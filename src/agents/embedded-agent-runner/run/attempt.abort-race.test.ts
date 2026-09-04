import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildAgentRunTerminalOutcomeFromAttempt } from "../../agent-run-terminal-outcome.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

describe("runEmbeddedAttempt abort races", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it("preserves a run-budget timeout when abort blocks prompt submission", async () => {
    let releasePendingEvents!: () => void;
    const pendingEvents = new Promise<void>((resolve) => {
      releasePendingEvents = resolve;
    });
    const baseSubscribe = hoisted.subscribeEmbeddedAgentSessionMock.getMockImplementation();
    if (!baseSubscribe) {
      throw new Error("missing embedded subscription mock");
    }
    hoisted.subscribeEmbeddedAgentSessionMock.mockImplementation((params) => ({
      ...baseSubscribe(params),
      waitForPendingEvents: async () => await pendingEvents,
    }));

    const attempt = createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:telegram:direct:timeout",
      tempPaths,
      sessionPrompt: async () => {},
      attemptOverrides: {
        timeoutMs: 20,
        onAttemptTimeout: () => releasePendingEvents(),
      },
    });

    // The abort-blocked prompt release no longer unwinds the attempt: the run
    // settles so after-turn side effects still fire, and the run-budget
    // timeout attribution survives on the resolved terminal.
    const result = await attempt;

    expect(result.terminal).toMatchObject({ kind: "timeout" });
    expect(buildAgentRunTerminalOutcomeFromAttempt({ terminal: result.terminal })).toMatchObject({
      status: "timeout",
    });
  });
});
