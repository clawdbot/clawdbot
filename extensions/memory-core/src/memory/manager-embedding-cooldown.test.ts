// Memory Core tests cover embedding-provider billing cooldown state.
import { describe, expect, it } from "vitest";
import {
  computeNextMemoryEmbeddingCooldown,
  isMemoryEmbeddingCoolingDown,
} from "./manager-embedding-cooldown.js";

describe("memory embedding billing cooldown", () => {
  it("starts a fresh 30-minute cooldown on the first billing failure", () => {
    const state = computeNextMemoryEmbeddingCooldown({
      providerId: "openai",
      reason: "402 quota exceeded",
      nowMs: 1_000_000,
    });

    expect(state.consecutiveFailures).toBe(1);
    expect(state.untilMs).toBe(1_000_000 + 30 * 60_000);
  });

  it("doubles the cooldown for each consecutive failure on the same provider, capped at 6h", () => {
    let state = computeNextMemoryEmbeddingCooldown({
      providerId: "openai",
      reason: "402",
      nowMs: 0,
    });
    state = computeNextMemoryEmbeddingCooldown({
      providerId: "openai",
      reason: "402",
      previous: state,
      nowMs: 0,
    });
    expect(state.consecutiveFailures).toBe(2);
    expect(state.untilMs).toBe(60 * 60_000);

    for (let i = 0; i < 10; i++) {
      state = computeNextMemoryEmbeddingCooldown({
        providerId: "openai",
        reason: "402",
        previous: state,
        nowMs: 0,
      });
    }
    expect(state.untilMs).toBe(6 * 60 * 60_000);
  });

  it("resets the streak when a different provider fails", () => {
    const first = computeNextMemoryEmbeddingCooldown({
      providerId: "openai",
      reason: "402",
      nowMs: 0,
    });
    const second = computeNextMemoryEmbeddingCooldown({
      providerId: "gemini",
      reason: "402",
      previous: first,
      nowMs: 0,
    });

    expect(second.consecutiveFailures).toBe(1);
  });

  it("is only active for the matching provider before the deadline", () => {
    const state = computeNextMemoryEmbeddingCooldown({
      providerId: "openai",
      reason: "402",
      nowMs: 1000,
    });

    expect(isMemoryEmbeddingCoolingDown(state, "openai", 1000)).toBe(true);
    expect(isMemoryEmbeddingCoolingDown(state, "openai", state.untilMs)).toBe(false);
    expect(isMemoryEmbeddingCoolingDown(state, "gemini", 1000)).toBe(false);
    expect(isMemoryEmbeddingCoolingDown(undefined, "openai", 1000)).toBe(false);
  });
});
