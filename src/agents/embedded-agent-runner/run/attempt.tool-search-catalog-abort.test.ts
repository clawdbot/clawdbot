import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as toolSearchTesting } from "../../tool-search.test-support.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

function catalogProbeTools() {
  return [
    {
      name: "tool_search",
      description: "tool-search control surface",
      parameters: { type: "object", properties: {} },
      execute: async () => "",
    },
    {
      name: "cataloged_probe_tool",
      description: "deferred behind the catalog",
      parameters: { type: "object", properties: {} },
      execute: async () => "",
    },
  ];
}

describe("runEmbeddedAttempt tool-search catalog cleanup", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    toolSearchTesting.sessionCatalogs.clear();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
    toolSearchTesting.sessionCatalogs.clear();
  });

  it("clears the registered run catalog when the run aborts during prep", async () => {
    const abortController = new AbortController();
    const prompt = vi.fn(async () => {});
    const abortError = new Error("stopped during lock acquisition");
    abortError.name = "AbortError";
    let markLockRequested!: () => void;
    const lockRequested = new Promise<void>((resolve) => {
      markLockRequested = resolve;
    });
    hoisted.acquireSessionWriteLockMock.mockImplementationOnce(async (params) => {
      markLockRequested();
      await new Promise<void>((resolve) => {
        params.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw params.signal?.reason;
    });
    hoisted.createOpenClawCodingToolsMock.mockImplementation(() => catalogProbeTools());

    const runId = "run-catalog-abort";
    const attempt = createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:telegram:direct:123",
      tempPaths,
      sessionPrompt: prompt,
      attemptOverrides: {
        runId,
        abortSignal: abortController.signal,
        disableTools: false,
        config: {
          tools: { toolSearch: { enabled: true, mode: "tools" } },
        },
      },
    });
    await lockRequested;
    // Guards the test itself: without a registered catalog the assertion below
    // would pass vacuously.
    expect([...toolSearchTesting.sessionCatalogs.keys()]).toContain(`run:${runId}`);

    abortController.abort(abortError);
    await expect(attempt).rejects.toBe(abortError);

    expect(toolSearchTesting.sessionCatalogs.has(`run:${runId}`)).toBe(false);
  });
});
