// Control UI tests cover session run state behavior.
import { describe, expect, it } from "vitest";
import { isSessionRunActive } from "./session-run-state.ts";

describe("isSessionRunActive", () => {
  it("uses explicit live-run state over stale running status", () => {
    expect(isSessionRunActive({ status: "running", hasActiveRun: false })).toBe(false);
    expect(isSessionRunActive({ status: "running", hasActiveRun: true })).toBe(true);
  });

  it("keeps terminal status authoritative over stale active flags", () => {
    expect(isSessionRunActive({ status: "done", hasActiveRun: true })).toBe(false);
    expect(isSessionRunActive({ status: "failed", hasActiveRun: true })).toBe(false);
    expect(isSessionRunActive({ status: "killed", hasActiveRun: true })).toBe(false);
    expect(isSessionRunActive({ status: "timeout", hasActiveRun: true })).toBe(false);
  });

  it("keeps legacy running status active when no live-run flag exists", () => {
    expect(isSessionRunActive({ status: "running" })).toBe(true);
    expect(isSessionRunActive({ hasActiveRun: true })).toBe(true);
  });
});
