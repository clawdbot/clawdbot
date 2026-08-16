// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isCriticalObserverHealth, projectSessionObserverDigest } from "./observer-digest.ts";

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
