import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";

const mockedLog = vi.hoisted(() => ({
  info: vi.fn<(msg: string) => void>(),
  warn: vi.fn<(msg: string) => void>(),
  error: vi.fn<(msg: string) => void>(),
  debug: vi.fn<(msg: string) => void>(),
  isEnabled: vi.fn(() => false),
  child: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => mockedLog,
}));
/**
 * Context-pressure awareness tests.
 *
 * Tests the `checkContextPressure` injection logic that fires
 * [system:context-pressure] events when session token usage crosses
 * configurable thresholds. Dedup via `lastContextPressureBand` on
 * the session entry prevents repeated events within the same band.
 *
 * The function under test is imported from the canonical continuation
 * context-pressure module.
 * Signature:
 *   checkContextPressure(params: {
 *     sessionEntry: SessionEntry;
 *     sessionKey: string;
 *     contextPressureThreshold: number;
 *     contextWindowTokens: number;
 *   }): { fired: boolean; band: number }
 */
import { checkContextPressure } from "../continuation/context-pressure.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/** Partial mock — SessionEntry has ~40 optional fields; we only set what the function reads. */
function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    totalTokens: 0,
    totalTokensFresh: true,
    lastContextPressureBand: undefined,
    ...overrides,
  } as SessionEntry;
}

const SESSION_KEY = "test:context-pressure";
const CONTEXT_WINDOW = 100_000; // 100k token context window

/* ------------------------------------------------------------------ */
/*  Setup / teardown                                                  */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  resetSystemEventsForTest();
  mockedLog.warn.mockClear();
  mockedLog.debug.mockClear();
});

afterEach(() => {
  resetSystemEventsForTest();
});

/* ------------------------------------------------------------------ */
/*  No event when threshold not configured                            */
/* ------------------------------------------------------------------ */

describe("checkContextPressure", () => {
  it("does not fire when contextPressureThreshold is undefined", () => {
    const entry = makeSessionEntry({ totalTokens: 90_000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: undefined as unknown as number,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(false);
    expect(result.band).toBe(0);
    const events = peekSystemEvents(SESSION_KEY);
    expect(events).toHaveLength(0);
  });

  it("does not fire when contextPressureThreshold is 0 if called directly", () => {
    const entry = makeSessionEntry({ totalTokens: 90_000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(false);
    expect(result.band).toBe(0);
    expect(peekSystemEvents(SESSION_KEY)).toHaveLength(0);
  });

  /* ---------------------------------------------------------------- */
  /*  No event below threshold                                        */
  /* ---------------------------------------------------------------- */

  it("does not fire at 75% when threshold is 0.8", () => {
    const entry = makeSessionEntry({ totalTokens: 75_000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(false);
    expect(result.band).toBe(0);
  });

  it("does not fire at exactly threshold boundary minus 1 token", () => {
    const entry = makeSessionEntry({ totalTokens: 79_999, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(false);
    expect(result.band).toBe(0);
  });

  it("fires the configured early-warning band below threshold", () => {
    const entry = makeSessionEntry({ totalTokens: 25_000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
      earlyWarningBand: 0.3125,
    });
    expect(result.fired).toBe(true);
    expect(result.band).toBe(25);
    expect(entry.lastContextPressureBand).toBe(25);
  });

  it("does not fire below threshold when early-warning band is 0", () => {
    const entry = makeSessionEntry({ totalTokens: 25_000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
      earlyWarningBand: 0,
    });
    expect(result.fired).toBe(false);
    expect(result.band).toBe(0);
  });

  /* ---------------------------------------------------------------- */
  /*  Event fires at threshold                                        */
  /* ---------------------------------------------------------------- */

  it("fires at 80% when threshold is 0.8", () => {
    const entry = makeSessionEntry({ totalTokens: 80_000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(true);
    expect(result.band).toBe(80);
    expect(entry.lastContextPressureBand).toBe(80);
  });

  it("fires at 85% when threshold is 0.8 (still in first band)", () => {
    const entry = makeSessionEntry({ totalTokens: 85_000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(true);
    expect(result.band).toBe(80);
  });

  /* ---------------------------------------------------------------- */
  /*  Band escalation                                                 */
  /* ---------------------------------------------------------------- */

  it("fires at 90% with band 90", () => {
    const entry = makeSessionEntry({ totalTokens: 90_000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(true);
    expect(result.band).toBe(90);
    expect(entry.lastContextPressureBand).toBe(90);
  });

  it("fires at 95% with band 95 and imminent language", () => {
    const entry = makeSessionEntry({ totalTokens: 95_000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(true);
    expect(result.band).toBe(95);
    expect(entry.lastContextPressureBand).toBe(95);
    // Verify the event text contains imminent language
    const events = peekSystemEvents(SESSION_KEY);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatch(/imminent/i);
  });

  it("fires at 99% with band 95", () => {
    const entry = makeSessionEntry({ totalTokens: 99_000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(true);
    expect(result.band).toBe(95);
  });

  /* ---------------------------------------------------------------- */
  /*  Dedup — no duplicate within same band                           */
  /* ---------------------------------------------------------------- */

  it("does not fire again within the same band", () => {
    const entry = makeSessionEntry({
      totalTokens: 82_000,
      totalTokensFresh: true,
      lastContextPressureBand: 80,
    });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(false);
    expect(result.band).toBe(80);
  });

  it("does not fire at 88% when band 80 already emitted", () => {
    const entry = makeSessionEntry({
      totalTokens: 88_000,
      totalTokensFresh: true,
      lastContextPressureBand: 80,
    });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(false);
    expect(result.band).toBe(80);
  });

  /* ---------------------------------------------------------------- */
  /*  Dedup — fires when crossing into next band                      */
  /* ---------------------------------------------------------------- */

  it("fires when crossing from band 80 to band 90", () => {
    const entry = makeSessionEntry({
      totalTokens: 91_000,
      totalTokensFresh: true,
      lastContextPressureBand: 80,
    });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(true);
    expect(result.band).toBe(90);
    expect(entry.lastContextPressureBand).toBe(90);
  });

  it("fires when crossing from band 90 to band 95", () => {
    const entry = makeSessionEntry({
      totalTokens: 96_000,
      totalTokensFresh: true,
      lastContextPressureBand: 90,
    });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(true);
    expect(result.band).toBe(95);
    expect(entry.lastContextPressureBand).toBe(95);
  });

  /* ---------------------------------------------------------------- */
  /*  Stale data guard                                                */
  /* ---------------------------------------------------------------- */

  it("does not fire when totalTokensFresh is false", () => {
    const entry = makeSessionEntry({
      totalTokens: 90_000,
      totalTokensFresh: false,
    });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(false);
    expect(result.band).toBe(0);
  });

  it("does not fire when totalTokens is undefined", () => {
    const entry = makeSessionEntry({
      totalTokens: undefined,
      totalTokensFresh: true,
    });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(false);
    expect(result.band).toBe(0);
  });

  it("does not fire when totalTokens is 0", () => {
    const entry = makeSessionEntry({
      totalTokens: 0,
      totalTokensFresh: true,
    });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(false);
    expect(result.band).toBe(0);
  });

  /* ---------------------------------------------------------------- */
  /*  Context window edge cases                                       */
  /* ---------------------------------------------------------------- */

  it("does not fire when contextWindowTokens is 0", () => {
    const entry = makeSessionEntry({ totalTokens: 90_000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: 0,
    });
    expect(result.fired).toBe(false);
    expect(result.band).toBe(0);
  });

  /* ---------------------------------------------------------------- */
  /*  Event text content                                              */
  /* ---------------------------------------------------------------- */

  it("includes correct percentage in event text", () => {
    const entry = makeSessionEntry({ totalTokens: 85_000, totalTokensFresh: true });
    checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    const events = peekSystemEvents(SESSION_KEY);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatch(/85%/);
  });

  it("includes token counts in event text", () => {
    const entry = makeSessionEntry({ totalTokens: 85_000, totalTokensFresh: true });
    checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    const events = peekSystemEvents(SESSION_KEY);
    expect(events.length).toBeGreaterThan(0);
    // 85k / 100k
    expect(events[0]).toMatch(/85k/);
    expect(events[0]).toMatch(/100k/);
  });

  it("uses post-compaction-staging language at sub-95% bands", () => {
    const entry = makeSessionEntry({ totalTokens: 85_000, totalTokensFresh: true });
    checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    const events = peekSystemEvents(SESSION_KEY);
    expect(events.length).toBeGreaterThan(0);
    // The urgency text below 95% names
    // continue_delegate(mode='post-compaction') for staging working-state survival,
    // rather than the legacy "evacuat" wording. This test pins the current wording.
    expect(events[0]).toMatch(/post-compaction/);
    expect(events[0]).toMatch(/working-state survival/);
    expect(events[0]).not.toMatch(/imminent/i);
  });

  it("uses imminent language at 95%+ band", () => {
    const entry = makeSessionEntry({ totalTokens: 97_000, totalTokensFresh: true });
    checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    const events = peekSystemEvents(SESSION_KEY);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatch(/imminent/i);
  });

  /* ---------------------------------------------------------------- */
  /*  Custom threshold values                                         */
  /* ---------------------------------------------------------------- */

  it("respects custom threshold of 0.5", () => {
    const entry = makeSessionEntry({ totalTokens: 50_000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.5,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(true);
    expect(result.band).toBe(50);
  });

  it("does not fire below custom threshold of 0.5", () => {
    const entry = makeSessionEntry({ totalTokens: 49_000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.5,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(false);
    expect(result.band).toBe(0);
  });

  it("respects thresholds above 90% without collapsing to the 90 band", () => {
    const entry = makeSessionEntry({ totalTokens: 94_000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.94,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(true);
    expect(result.band).toBe(94);
  });

  it("does not backslide from a custom 94% band to 90% on later turns", () => {
    const entry = makeSessionEntry({
      totalTokens: 91_000,
      totalTokensFresh: true,
      lastContextPressureBand: 94,
    });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.94,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(false);
    expect(result.band).toBe(0);
  });

  /* ---------------------------------------------------------------- */
  /*  Session reset (band clears)                                     */
  /* ---------------------------------------------------------------- */

  it("fires again after band is cleared (session reset)", () => {
    const entry = makeSessionEntry({
      totalTokens: 85_000,
      totalTokensFresh: true,
      lastContextPressureBand: undefined, // cleared by session reset
    });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(true);
    expect(result.band).toBe(80);
  });

  /* ---------------------------------------------------------------- */
  /*  Edge cases from review (ratio > 1.0, negative tokens)           */
  /* ---------------------------------------------------------------- */

  it("handles ratio > 1.0 (tokens exceed window) as band 95", () => {
    const entry = makeSessionEntry({ totalTokens: 120_000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(true);
    expect(result.band).toBe(95);
  });

  it("does not fire for negative totalTokens", () => {
    const entry = makeSessionEntry({ totalTokens: -1000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(false);
    expect(result.band).toBe(0);
  });

  it("does not fire for NaN totalTokens", () => {
    const entry = makeSessionEntry({ totalTokens: Number.NaN, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(false);
    expect(result.band).toBe(0);
  });

  it("custom threshold above 0.9 is not shadowed by fixed 90 band", () => {
    // At 92% usage with threshold 0.92, should fire at custom band 92, not fixed band 90
    const entry = makeSessionEntry({ totalTokens: 92000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.92,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(true);
    expect(result.band).toBe(92);
  });

  it("custom threshold 0.94 at 91% does not fire (below threshold)", () => {
    const entry = makeSessionEntry({ totalTokens: 91000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.94,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(false);
    expect(result.band).toBe(0);
  });

  it("fixed 95 band still fires above custom threshold in (0.9, 0.95)", () => {
    const entry = makeSessionEntry({ totalTokens: 96000, totalTokensFresh: true });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.92,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(true);
    expect(result.band).toBe(95);
  });

  it("band resets allow re-fire after compaction", () => {
    const entry = makeSessionEntry({
      totalTokens: 92000,
      totalTokensFresh: true,
      lastContextPressureBand: 0,
    });
    const result = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result.fired).toBe(true);
    expect(result.band).toBe(90);
    // After compaction resets the band to 0 and tokens drop:
    entry.lastContextPressureBand = 0;
    entry.totalTokens = 82000;
    const result2 = checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(result2.fired).toBe(true);
    expect(result2.band).toBe(80);
  });

  /* ---------------------------------------------------------------- */
  /*  Regression: log.warn for [context-pressure:fire] (not debug)    */
  /* ---------------------------------------------------------------- */

  it("emits [context-pressure:fire] via log.warn (not log.debug) on pre-run path", () => {
    mockedLog.warn.mockClear();
    mockedLog.debug.mockClear();
    const entry = makeSessionEntry({ totalTokens: 85_000, totalTokensFresh: true });
    checkContextPressure({
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      contextPressureThreshold: 0.8,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(mockedLog.warn).toHaveBeenCalledWith(expect.stringContaining("[context-pressure:fire]"));
    expect(mockedLog.debug).not.toHaveBeenCalledWith(
      expect.stringContaining("[context-pressure:fire]"),
    );
  });
});
