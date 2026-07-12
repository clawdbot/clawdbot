import { execFileSync } from "node:child_process";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  clockToMs,
  extractJsonPayload,
  parseCardsJson,
  parseObservationSegments,
  pickKeyframeId,
  revisionWindow,
  sampleFrames,
  selectBatchFrames,
  validateCardCoverage,
} from "./analyze.js";

const DAY = "2026-07-03";
const dayMs = (clock: string) => {
  const ms = clockToMs(DAY, clock);
  if (ms === null) {
    throw new Error(`bad clock ${clock}`);
  }
  return ms;
};

describe("clockToMs", () => {
  it("parses 24h and 12h clocks on the local day", () => {
    expect(dayMs("13:05:30") - dayMs("13:05:00")).toBe(30_000);
    expect(dayMs("1:05 pm")).toBe(dayMs("13:05:00"));
    expect(dayMs("12:00 am")).toBe(dayMs("00:00:00"));
  });

  it("rejects malformed input", () => {
    expect(clockToMs(DAY, "25:00:00")).toBeNull();
    expect(clockToMs(DAY, "half past nine")).toBeNull();
    expect(clockToMs("not-a-day", "10:00:00")).toBeNull();
  });

  it("preserves local wall-clock time across a DST transition", () => {
    const moduleUrl = new URL("./analyze.ts", import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--eval",
        `const { clockToMs } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify([clockToMs("2026-03-08", "10:00:00"), clockToMs("2026-03-08", "02:30:00")]));`,
      ],
      { encoding: "utf8", env: { ...process.env, TZ: "America/New_York" } },
    );

    expect(JSON.parse(output)).toEqual([Date.UTC(2026, 2, 8, 14), null]);
  });
});

describe("extractJsonPayload", () => {
  it("strips fences and surrounding prose", () => {
    expect(extractJsonPayload('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonPayload('Here you go:\n[{"a":1}]\nHope that helps!')).toBe('[{"a":1}]');
  });
});

describe("parseObservationSegments", () => {
  const startMs = dayMs("10:00:00");
  const endMs = dayMs("10:15:00");

  it("parses and clamps segments into the batch window", () => {
    const raw = JSON.stringify({
      segments: [
        { start: "09:55:00", end: "10:05:00", description: "VS Code: editing store.ts" },
        { start: "10:05:00", end: "10:20:00", description: "Chrome: reviewing PR #99" },
      ],
    });
    const segments = parseObservationSegments({ raw, day: DAY, startMs, endMs });
    expect(segments).toHaveLength(2);
    expect(expectDefined(segments[0], "first observation segment").startMs).toBe(startMs);
    expect(expectDefined(segments[1], "second observation segment").endMs).toBe(endMs);
  });

  it("returns empty on unparseable output", () => {
    expect(parseObservationSegments({ raw: "no json here", day: DAY, startMs, endMs })).toEqual([]);
  });
});

describe("parseCardsJson", () => {
  const windowStartMs = dayMs("10:00:00");
  const windowEndMs = dayMs("11:00:00");

  const card = (overrides: Record<string, unknown> = {}) => ({
    startTime: "10:00:00",
    endTime: "10:30:00",
    category: "coding",
    title: "Working on logbook store",
    summary: "Implemented SQLite store",
    detailedSummary: "Added frames and cards tables.",
    distractions: [],
    appSites: { primary: "github.com" },
    ...overrides,
  });

  it("accepts a valid card array and normalizes fields", () => {
    const result = parseCardsJson({
      raw: JSON.stringify([
        card({ category: "CODING", appSites: { primary: "https://GitHub.com/openclaw" } }),
      ]),
      day: DAY,
      windowStartMs,
      windowEndMs,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const draft = expectDefined(result.drafts[0], "normalized logbook draft");
      expect(draft.category).toBe("coding");
      expect(draft.appPrimary).toBe("github.com");
    }
  });

  it("maps unknown categories to other", () => {
    const result = parseCardsJson({
      raw: JSON.stringify([card({ category: "quantum-vibes" })]),
      day: DAY,
      windowStartMs,
      windowEndMs,
    });
    expect(result.ok && expectDefined(result.drafts[0], "unknown-category draft").category).toBe(
      "other",
    );
  });

  it("trims sub-minute overlaps and rejects large ones", () => {
    const trimmed = parseCardsJson({
      raw: JSON.stringify([
        card({ startTime: "10:00:00", endTime: "10:30:30" }),
        card({ startTime: "10:30:00", endTime: "11:00:00", title: "Second" }),
      ]),
      day: DAY,
      windowStartMs,
      windowEndMs,
    });
    expect(trimmed.ok).toBe(true);
    if (trimmed.ok) {
      const first = expectDefined(trimmed.drafts[0], "first overlap-trimmed draft");
      const second = expectDefined(trimmed.drafts[1], "second overlap-trimmed draft");
      expect(second.startMs).toBe(first.endMs);
    }

    const rejected = parseCardsJson({
      raw: JSON.stringify([
        card({ startTime: "10:00:00", endTime: "10:45:00" }),
        card({ startTime: "10:30:00", endTime: "11:00:00", title: "Second" }),
      ]),
      day: DAY,
      windowStartMs,
      windowEndMs,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error).toContain("overlap");
    }
  });

  it("reports actionable errors for the correction round-trip", () => {
    const result = parseCardsJson({
      raw: JSON.stringify([card({ startTime: "later that day" })]),
      day: DAY,
      windowStartMs,
      windowEndMs,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("startTime");
    }
  });
});

describe("selectBatchFrames", () => {
  const windowMs = 15 * 60_000;
  const t0 = dayMs("10:00:00");
  const frame = (id: number, offsetSec: number) => ({ id, capturedAtMs: t0 + offsetSec * 1000 });

  it("keeps an in-progress window open", () => {
    const frames = [frame(1, 0), frame(2, 30), frame(3, 60)];
    expect(selectBatchFrames({ frames, windowMs, nowMs: t0 + 5 * 60_000 })).toBeNull();
  });

  it("closes an elapsed window at its boundary so batches meet cleanly", () => {
    const frames = [frame(1, 0), frame(2, 30), frame(3, 60)];
    const selection = selectBatchFrames({ frames, windowMs, nowMs: t0 + windowMs + 1000 });
    expect(selection?.frameIds).toEqual([1, 2, 3]);
    expect(selection?.startMs).toBe(t0);
    expect(selection?.endMs).toBe(t0 + windowMs);
  });

  it("keeps the boundary when the next frame starts the following window", () => {
    const frames = [frame(1, 0), frame(2, 30), frame(3, 60), frame(4, 15 * 60)];
    const selection = selectBatchFrames({ frames, windowMs, nowMs: t0 + windowMs + 1000 });
    expect(selection?.frameIds).toEqual([1, 2, 3]);
    expect(selection?.endMs).toBe(t0 + windowMs);
  });

  it("splits on capture gaps without claiming the idle span", () => {
    const frames = [frame(1, 0), frame(2, 30), frame(3, 400)];
    const selection = selectBatchFrames({ frames, windowMs, nowMs: t0 + 60_000 });
    expect(selection?.frameIds).toEqual([1, 2]);
    expect(selection?.endMs).toBe(t0 + 30_000 + 1);
  });

  it("force-closes an in-progress window at the last observed frame", () => {
    const frames = [frame(1, 0), frame(2, 30)];
    expect(selectBatchFrames({ frames, windowMs, nowMs: t0 + 60_000 })).toBeNull();
    const forced = selectBatchFrames({ frames, windowMs, nowMs: t0 + 60_000, force: true });
    expect(forced?.frameIds).toEqual([1, 2]);
    expect(forced?.endMs).toBe(t0 + 30_000 + 1);
  });

  it("splits at local midnight so batch clocks stay on one day", () => {
    const nearMidnight = new Date(`${DAY}T23:59:30`).getTime();
    const frames = [
      { id: 1, capturedAtMs: nearMidnight },
      { id: 2, capturedAtMs: nearMidnight + 20_000 },
      { id: 3, capturedAtMs: nearMidnight + 50_000 },
    ];
    const selection = selectBatchFrames({ frames, windowMs, nowMs: nearMidnight + 60_000 });
    expect(selection?.frameIds).toEqual([1, 2]);
    expect(selection?.endMs).toBe(nearMidnight + 20_000 + 1);
  });

  it("caps an elapsed window at midnight without a next-day frame", () => {
    const nearMidnight = new Date(`${DAY}T23:59:30`).getTime();
    const midnight = new Date(nearMidnight);
    midnight.setHours(24, 0, 0, 0);
    const frames = [
      { id: 1, capturedAtMs: nearMidnight },
      { id: 2, capturedAtMs: nearMidnight + 20_000 },
    ];
    const selection = selectBatchFrames({ frames, windowMs, nowMs: nearMidnight + windowMs });
    expect(selection?.frameIds).toEqual([1, 2]);
    expect(selection?.endMs).toBe(midnight.getTime());
  });
});

describe("sampleFrames", () => {
  it("keeps small sets and evenly samples large ones", () => {
    expect(sampleFrames([1, 2, 3], 16)).toEqual([1, 2, 3]);
    expect(sampleFrames([1, 2, 3], 1)).toEqual([1]);
    expect(sampleFrames([1, 2, 3], 0)).toEqual([]);
    const sampled = sampleFrames(
      Array.from({ length: 100 }, (_, i) => i),
      16,
    );
    expect(sampled.length).toBeLessThanOrEqual(16);
    expect(sampled[0]).toBe(0);
    expect(sampled[sampled.length - 1]).toBe(99);
  });
});

describe("validateCardCoverage", () => {
  const window = { windowStartMs: dayMs("10:00:00"), windowEndMs: dayMs("11:00:00") };
  const span = (start: string, end: string) => ({ startMs: dayMs(start), endMs: dayMs(end) });

  it("accepts drafts covering all required spans within tolerance", () => {
    const result = validateCardCoverage({
      drafts: [span("10:01:00", "10:30:00"), span("10:30:00", "10:59:00")],
      requiredSpans: [span("10:00:00", "11:00:00")],
      ...window,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects partial outputs that would erase previous cards", () => {
    // Model returned only the new batch span, dropping the 10:00-10:30 card.
    const result = validateCardCoverage({
      drafts: [span("10:30:00", "11:00:00")],
      requiredSpans: [span("10:00:00", "10:30:00"), span("10:30:00", "11:00:00")],
      ...window,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not covered");
    }
  });

  it("rejects drafts outside the revision window", () => {
    const result = validateCardCoverage({
      drafts: [span("09:00:00", "11:00:00")],
      requiredSpans: [span("10:00:00", "11:00:00")],
      ...window,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("outside the revision window");
    }
  });

  it("tolerates gaps inside required spans up to the tolerance", () => {
    const result = validateCardCoverage({
      drafts: [span("10:00:00", "10:29:00"), span("10:30:30", "11:00:00")],
      requiredSpans: [span("10:00:00", "11:00:00")],
      ...window,
    });
    expect(result.ok).toBe(true);
  });
});

describe("revisionWindow / pickKeyframeId", () => {
  it("expands the window to cover previous draft cards", () => {
    const window = revisionWindow({
      batchStartMs: dayMs("10:30:00"),
      batchEndMs: dayMs("10:45:00"),
      previousCards: [
        {
          id: 1,
          day: DAY,
          startMs: dayMs("10:00:00"),
          endMs: dayMs("10:30:00"),
          title: "t",
          summary: "s",
          detail: "",
          category: "coding",
          distractions: [],
        },
      ],
    });
    expect(window.startMs).toBe(dayMs("10:00:00"));
    expect(window.endMs).toBe(dayMs("10:45:00"));
  });

  it("picks the frame closest to the card midpoint", () => {
    const frames = [
      { id: 1, capturedAtMs: dayMs("10:00:00") },
      { id: 2, capturedAtMs: dayMs("10:14:00") },
      { id: 3, capturedAtMs: dayMs("10:29:00") },
    ];
    const keyframe = pickKeyframeId(
      { startMs: dayMs("10:00:00"), endMs: dayMs("10:30:00") },
      frames,
    );
    expect(keyframe).toBe(2);
  });
});
