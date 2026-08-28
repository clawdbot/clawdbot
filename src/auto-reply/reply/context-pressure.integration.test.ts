/**
 * Phase 2 integration test: verifies context-pressure event appears in the
 * system event queue BEFORE buildQueuedSystemPrompt would drain it.
 *
 * This exercises the real enqueueSystemEvent → peekSystemEventEntries path
 * to confirm the P1 fix (event ordering) works end-to-end.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { peekSystemEventEntries, drainSystemEventEntries } from "../../infra/system-events.js";
import { checkContextPressure } from "../continuation/context-pressure.js";

const TEST_SESSION_KEY = "phase2-integration-test";

/** Helper: partial SessionEntry for testing */
function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    totalTokens: 8000,
    lastContextPressureBand: undefined,
    ...overrides,
  } as SessionEntry;
}

describe("Phase 2 integration: context-pressure → event queue → drain ordering", () => {
  beforeEach(() => {
    // Drain any leftover events from prior tests
    drainSystemEventEntries(TEST_SESSION_KEY);
  });

  it("event is available in queue BEFORE drain (P1 fix verification)", () => {
    const entry = makeEntry({ totalTokens: 8500 });

    // 1. checkContextPressure enqueues the event
    const { fired, band } = checkContextPressure({
      sessionEntry: entry,
      sessionKey: TEST_SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: 10000,
    });

    expect(fired).toBe(true);
    expect(band).toBe(80);

    // 2. Peek — event should be visible (this is what buildQueuedSystemPrompt reads)
    const peeked = peekSystemEventEntries(TEST_SESSION_KEY);
    expect(peeked).toBeDefined();
    expect(peeked.length).toBeGreaterThanOrEqual(1);
    const pressureEvent = peeked.find((e) => e.text?.includes("[system:context-pressure]"));
    expect(pressureEvent).toBeDefined();
    expect(pressureEvent!.text).toContain("85%");
    expect(pressureEvent!.text).toContain("context window consumed");

    // 3. Drain — event should be consumed (simulating buildQueuedSystemPrompt)
    const drained = drainSystemEventEntries(TEST_SESSION_KEY);
    expect(drained).toBeDefined();
    const drainedPressure = drained.find((e) => e.text?.includes("[system:context-pressure]"));
    expect(drainedPressure).toBeDefined();

    // 4. After drain, queue should be empty
    const afterDrain = peekSystemEventEntries(TEST_SESSION_KEY);
    expect(!afterDrain || afterDrain.length === 0).toBe(true);
  });

  it("band escalation: 80 → 90 → 95 each produce separate events", () => {
    const entry = makeEntry({ totalTokens: 8000 });

    // Band 80 (80%)
    checkContextPressure({
      sessionEntry: entry,
      sessionKey: TEST_SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: 10000,
    });
    let events = drainSystemEventEntries(TEST_SESSION_KEY);
    expect(events.some((e) => e.text?.includes("[system:context-pressure]"))).toBe(true);

    // Band 90 (simulate tokens growing)
    entry.totalTokens = 9200;
    checkContextPressure({
      sessionEntry: entry,
      sessionKey: TEST_SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: 10000,
    });
    events = drainSystemEventEntries(TEST_SESSION_KEY);
    expect(events.some((e) => e.text?.includes("[system:context-pressure]"))).toBe(true);

    // Band 95
    entry.totalTokens = 9700;
    checkContextPressure({
      sessionEntry: entry,
      sessionKey: TEST_SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: 10000,
    });
    events = drainSystemEventEntries(TEST_SESSION_KEY);
    const imminent = events.find((e) => e.text?.toLowerCase().includes("imminent"));
    expect(imminent).toBeDefined();
  });

  it("dedup: same band does not produce duplicate events", () => {
    const entry = makeEntry({ totalTokens: 8500 });

    // First fire at band 80
    const r1 = checkContextPressure({
      sessionEntry: entry,
      sessionKey: TEST_SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: 10000,
    });
    expect(r1.fired).toBe(true);
    drainSystemEventEntries(TEST_SESSION_KEY);

    // Second call at same band — should NOT fire
    const r2 = checkContextPressure({
      sessionEntry: entry,
      sessionKey: TEST_SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: 10000,
    });
    expect(r2.fired).toBe(false);

    // Queue should be empty
    const events = peekSystemEventEntries(TEST_SESSION_KEY);
    expect(!events || events.length === 0).toBe(true);
  });

  it("threshold 0.1 fires immediately (Phase 2 live-fire config)", () => {
    const entry = makeEntry({ totalTokens: 1500 });

    const { fired, band } = checkContextPressure({
      sessionEntry: entry,
      sessionKey: TEST_SESSION_KEY,
      contextPressureThreshold: 0.1,
      contextWindowTokens: 10000,
    });

    expect(fired).toBe(true);
    expect(band).toBe(10);

    const events = drainSystemEventEntries(TEST_SESSION_KEY);
    const pressureEvent = events.find((e) => e.text?.includes("[system:context-pressure]"));
    expect(pressureEvent).toBeDefined();
    expect(pressureEvent!.text).toContain("15%");
  });

  it("disabled config produces no events", () => {
    const entry = makeEntry({ totalTokens: 9500 });

    const { fired } = checkContextPressure({
      sessionEntry: entry,
      sessionKey: TEST_SESSION_KEY,
      contextPressureThreshold: undefined,
      contextWindowTokens: 10000,
    });

    expect(fired).toBe(false);
    const events = peekSystemEventEntries(TEST_SESSION_KEY);
    expect(!events || events.length === 0).toBe(true);
  });
});
