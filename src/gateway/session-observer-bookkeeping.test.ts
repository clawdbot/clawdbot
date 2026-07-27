import { describe, expect, it } from "vitest";

describe("session observer run bookkeeping", () => {
  it("bounds dormant runs and preserves revision continuity for evicted entries", async () => {
    const { rememberSessionObserverDormantRun } = await import("./session-observer-model.js");
    const runs = new Map();
    const floors = new Map();
    for (let index = 0; index < 300; index += 1) {
      rememberSessionObserverDormantRun(runs, floors, {
        sessionKey: index === 0 ? "global" : `agent:main:session-${index}`,
        sessionId: `session-${index}`,
        runId: `run-${index}`,
        agentId: index === 0 ? "work" : "main",
        utilityModelRef: "openai/gpt-test",
        startedAt: index,
        lastPersistedAt: undefined,
        revision: index + 1,
        digestCount: 1,
        consecutiveFailures: 0,
        planProgress: undefined,
        previousDigest: undefined,
      });
    }
    expect(runs.size).toBe(256);
    expect(runs.has("run-0")).toBe(false);
    expect(runs.has("run-299")).toBe(true);
    expect(floors.get("agent:work:global")?.revision).toBe(1);
    expect(floors.has("global")).toBe(false);
  });

  it("bounds disabled-run bookkeeping", async () => {
    const { rememberSessionObserverDisabledRun } = await import("./session-observer-model.js");
    const runs = new Set<string>();
    for (let index = 0; index < 600; index += 1) {
      rememberSessionObserverDisabledRun(runs, `run-${index}`);
    }
    expect(runs.size).toBe(512);
    expect(runs.has("run-0")).toBe(false);
    expect(runs.has("run-599")).toBe(true);
  });
});
