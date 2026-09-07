// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isCriticalObserverHealth,
  projectSessionObserverDigest,
  resolveChatPaneObserverRunId,
} from "./observer-digest.ts";

describe("projectSessionObserverDigest", () => {
  it("binds a session-row projection to its owning session", () => {
    expect(
      projectSessionObserverDigest("agent:main:projected", {
        runId: "run-1",
        revision: 2,
        updatedAt: 3,
        headline: "Projected",
        health: "on-track",
      }),
    ).toEqual({
      sessionKey: "agent:main:projected",
      runId: "run-1",
      revision: 2,
      updatedAt: 3,
      headline: "Projected",
      health: "on-track",
    });
  });
});

describe("isCriticalObserverHealth", () => {
  it("recognizes only health states that require operator attention", () => {
    expect(isCriticalObserverHealth("stuck")).toBe(true);
    expect(isCriticalObserverHealth("waiting-on-user")).toBe(true);
    expect(isCriticalObserverHealth("done")).toBe(false);
    expect(isCriticalObserverHealth("failed")).toBe(false);
  });
});

describe("resolveChatPaneObserverRunId", () => {
  it("uses only a local run or the observer digest's exact active membership", () => {
    const session = { hasActiveRun: true, activeRunIds: ["other-run", "observer-run"] };

    expect(resolveChatPaneObserverRunId({ localRunId: "local-run", session, digest: null })).toBe(
      "local-run",
    );
    expect(
      resolveChatPaneObserverRunId({
        localRunId: null,
        session,
        digest: { runId: "observer-run" },
      }),
    ).toBe("observer-run");
    expect(
      resolveChatPaneObserverRunId({
        localRunId: null,
        session,
        digest: { runId: "stale-run" },
      }),
    ).toBeNull();
  });
});
