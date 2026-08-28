import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCircuitBreakerKey,
  getCircuitBreakerEntry,
  isCircuitBreakerOpen,
  recordCircuitBreakerTimeout,
  resetActiveRecallStateForTests,
} from "./recall-state.js";
import { DEFAULT_MAX_CACHE_ENTRIES } from "./types.js";

describe("active-memory timeout circuit breakers", () => {
  beforeEach(() => {
    resetActiveRecallStateForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    resetActiveRecallStateForTests();
    vi.useRealTimers();
  });

  it.each([5_000, 120_000])("expires other entries after the %d ms cooldown", (cooldownMs) => {
    recordCircuitBreakerTimeout("old", cooldownMs);
    vi.advanceTimersByTime(cooldownMs - 1);
    recordCircuitBreakerTimeout("recent", cooldownMs);
    vi.advanceTimersByTime(1);
    recordCircuitBreakerTimeout("new", cooldownMs);

    expect(getCircuitBreakerEntry("old")).toBeUndefined();
    expect(getCircuitBreakerEntry("recent")?.consecutiveTimeouts).toBe(1);
    expect(getCircuitBreakerEntry("new")?.consecutiveTimeouts).toBe(1);
  });

  it("restarts an expired key before adding a new timeout", () => {
    const cooldownMs = 5_000;
    recordCircuitBreakerTimeout("same", cooldownMs);
    vi.advanceTimersByTime(cooldownMs);
    recordCircuitBreakerTimeout("same", cooldownMs);

    expect(getCircuitBreakerEntry("same")?.consecutiveTimeouts).toBe(1);
    expect(isCircuitBreakerOpen("same", 2, cooldownMs)).toBe(false);
  });

  it("evicts the oldest key when the existing cache capacity is exceeded", () => {
    const cooldownMs = 120_000;
    for (let index = 0; index <= DEFAULT_MAX_CACHE_ENTRIES; index++) {
      recordCircuitBreakerTimeout(`model-${index}`, cooldownMs);
    }

    expect(getCircuitBreakerEntry("model-0")).toBeUndefined();
    expect(getCircuitBreakerEntry("model-1")?.consecutiveTimeouts).toBe(1);
    expect(getCircuitBreakerEntry(`model-${DEFAULT_MAX_CACHE_ENTRIES}`)?.consecutiveTimeouts).toBe(
      1,
    );
  });

  it("refreshes an existing key before evicting the least recently updated peer", () => {
    const cooldownMs = 120_000;
    for (let index = 0; index < DEFAULT_MAX_CACHE_ENTRIES; index++) {
      recordCircuitBreakerTimeout(`model-${index}`, cooldownMs);
    }
    vi.advanceTimersByTime(1);
    recordCircuitBreakerTimeout("model-0", cooldownMs);
    recordCircuitBreakerTimeout("newest", cooldownMs);

    expect(getCircuitBreakerEntry("model-0")?.consecutiveTimeouts).toBe(2);
    expect(getCircuitBreakerEntry("model-1")).toBeUndefined();
    expect(getCircuitBreakerEntry("newest")?.consecutiveTimeouts).toBe(1);
  });

  it("keeps circuit-breaker decisions scoped to the agent, provider, and model", () => {
    const cooldownMs = 5_000;
    const timedOutKey = buildCircuitBreakerKey("agent-a", "provider-a", "model-a");
    const otherProviderKey = buildCircuitBreakerKey("agent-a", "provider-b", "model-a");
    const otherModelKey = buildCircuitBreakerKey("agent-a", "provider-a", "model-b");
    const otherAgentKey = buildCircuitBreakerKey("agent-b", "provider-a", "model-a");

    recordCircuitBreakerTimeout(timedOutKey, cooldownMs);

    expect(isCircuitBreakerOpen(timedOutKey, 1, cooldownMs)).toBe(true);
    expect(isCircuitBreakerOpen(otherProviderKey, 1, cooldownMs)).toBe(false);
    expect(isCircuitBreakerOpen(otherModelKey, 1, cooldownMs)).toBe(false);
    expect(isCircuitBreakerOpen(otherAgentKey, 1, cooldownMs)).toBe(false);
  });
});
