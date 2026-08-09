import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createHarness, persistedLiveDigest } from "./session-observer.test-utils.js";

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

  it("reads a persisted global companion through its canonical agent store key", () => {
    const config = {
      gateway: { controlUi: { sessionObserver: true } },
      session: { scope: "global" as const },
      agents: {
        defaults: { utilityModel: "openai/gpt-test" },
        list: [{ id: "main", default: true }, { id: "work" }],
      },
    } satisfies OpenClawConfig;
    const digest = persistedLiveDigest({ agentId: "work", sessionKey: "global" });
    const readSession = vi.fn(() => ({
      sessionId: "global-session-id",
      updatedAt: 1_000,
      observerDigest: digest,
    }));
    const harness = createHarness({ subscribe: false, config, readSession });

    const snapshot = harness.observer.getCompanionSnapshot("agent:work:main");

    expect(readSession).toHaveBeenCalledWith("global", "work");
    expect(snapshot).toMatchObject({ agentId: "work", digest, runId: digest.runId });
    harness.observer.dispose();
  });
});
