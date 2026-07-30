// Coverage for trusted diagnostics emitted by a full embedded attempt.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPrivateData,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

describe("runEmbeddedAttempt diagnostics", () => {
  const tempPaths: string[] = [];

  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    resetDiagnosticEventsForTest();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    resetDiagnosticEventsForTest();
  });

  it("keeps run failure text on the trusted private channel", async () => {
    const completed: Array<{
      event: DiagnosticEventPayload;
      privateData: DiagnosticEventPrivateData;
    }> = [];
    const unsubscribe = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "run.completed") {
        completed.push({ event, privateData });
      }
    });

    try {
      await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:diagnostic-failure",
        tempPaths,
        sessionPrompt: async () => {
          throw new Error("provider stream failed");
        },
      });
      await waitForDiagnosticEventsDrained();
    } finally {
      unsubscribe();
    }

    expect(completed).toHaveLength(1);
    expect(completed[0]?.event).toMatchObject({
      type: "run.completed",
      outcome: "error",
      errorCategory: "Error",
    });
    expect(completed[0]?.event).not.toHaveProperty("error");
    expect(completed[0]?.privateData.errorMessage).toBe("provider stream failed");
  });
});
