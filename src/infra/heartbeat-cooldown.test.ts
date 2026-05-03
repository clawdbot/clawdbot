import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLOOD_THRESHOLD,
  DEFAULT_MIN_WAKE_SPACING_MS,
  recordRunStart,
  shouldDeferWake,
} from "./heartbeat-cooldown.js";

describe("shouldDeferWake", () => {
  type Input = Parameters<typeof shouldDeferWake>[0];
  function decide(input: Omit<Input, "intent"> & { intent?: Input["intent"] }) {
    return shouldDeferWake({ intent: "event", ...input });
  }

  // After-a-run baseline: agent has already run once, so the cooldown gate is
  // active for non-manual non-interval wakes.
  const afterRun = {
    nextDueMs: 100_000,
    now: 50_000,
    lastRunStartedAtMs: 49_000,
  };

  // Bootstrap baseline: agent has never run. nextDueMs is the first phase tick.
  const beforeFirstRun = {
    nextDueMs: 100_000,
    now: 50_000,
    lastRunStartedAtMs: undefined,
  };

  describe("manual wakes", () => {
    it("never defers manual wakes even within nextDueMs", () => {
      expect(decide({ ...afterRun, intent: "manual", reason: "manual" })).toEqual({
        defer: false,
      });
    });

    it("never defers manual wakes even within min-spacing window", () => {
      expect(
        decide({
          intent: "manual",
          now: 200_000,
          nextDueMs: 100_000,
          lastRunStartedAtMs: 199_900,
          reason: "manual",
        }),
      ).toEqual({ defer: false });
    });

    it("never defers manual wakes even during a flood", () => {
      const now = 1_000_000;
      const recentRunStarts = [
        now - 50_000,
        now - 40_000,
        now - 30_000,
        now - 20_000,
        now - 10_000,
      ];
      expect(
        decide({
          intent: "manual",
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - 10_000,
          recentRunStarts,
          reason: "manual",
        }),
      ).toEqual({ defer: false });
    });
  });

  describe("immediate wake intent (wake-now contracts)", () => {
    it("does not defer 'wake' even within nextDueMs (system event --mode now contract)", () => {
      expect(decide({ ...afterRun, intent: "immediate", reason: "wake" })).toEqual({
        defer: false,
      });
    });

    it("does not defer 'background-task' even within nextDueMs (task completion contract)", () => {
      expect(decide({ ...afterRun, intent: "immediate", reason: "background-task" })).toEqual({
        defer: false,
      });
    });

    it("does not defer 'background-task-blocked' even within nextDueMs", () => {
      expect(
        decide({ ...afterRun, intent: "immediate", reason: "background-task-blocked" }),
      ).toEqual({ defer: false });
    });

    it("does not defer explicit hook wake-now calls even within nextDueMs", () => {
      expect(decide({ ...afterRun, intent: "immediate", reason: "hook:wake" })).toEqual({
        defer: false,
      });
    });

    it("does not defer explicit cron wake-now calls even within nextDueMs", () => {
      expect(decide({ ...afterRun, intent: "immediate", reason: "cron:morning-brief" })).toEqual({
        defer: false,
      });
    });

    it("does not defer 'wake' within min-spacing window", () => {
      expect(
        decide({
          intent: "immediate",
          now: 200_000,
          nextDueMs: 100_000,
          lastRunStartedAtMs: 199_990,
          reason: "wake",
        }),
      ).toEqual({ defer: false });
    });

    it("defers acp spawn stream wakes when they use event intent", () => {
      expect(decide({ ...afterRun, source: "acp-spawn", reason: "acp:spawn:stream" })).toEqual({
        defer: true,
        reason: "not-due",
      });
    });

    it("flood guard still applies to 'wake' as a backstop against unexpected loops", () => {
      const now = 1_000_000;
      const recentRunStarts = [
        now - 50_000,
        now - 40_000,
        now - 30_000,
        now - 20_000,
        now - 10_000,
      ];
      expect(
        decide({
          intent: "immediate",
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - 10_000,
          recentRunStarts,
          reason: "wake",
        }),
      ).toEqual({ defer: true, reason: "flood" });
    });

    it("flood guard still applies to 'background-task' as a backstop", () => {
      const now = 1_000_000;
      const recentRunStarts = [
        now - 50_000,
        now - 40_000,
        now - 30_000,
        now - 20_000,
        now - 10_000,
      ];
      expect(
        decide({
          intent: "immediate",
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - 10_000,
          recentRunStarts,
          reason: "background-task",
        }),
      ).toEqual({ defer: true, reason: "flood" });
    });

    it("flood guard still applies to explicit wake-now bypass calls", () => {
      const now = 1_000_000;
      const recentRunStarts = [
        now - 50_000,
        now - 40_000,
        now - 30_000,
        now - 20_000,
        now - 10_000,
      ];
      expect(
        decide({
          intent: "immediate",
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - 10_000,
          recentRunStarts,
          reason: "hook:wake",
        }),
      ).toEqual({ defer: true, reason: "flood" });
    });
  });

  describe("scheduled intent", () => {
    it("defers with 'not-due' when now < nextDueMs (interval cooldown)", () => {
      expect(decide({ ...afterRun, intent: "scheduled", reason: "interval" })).toEqual({
        defer: true,
        reason: "not-due",
      });
    });

    it("defers interval wake before first run if nextDueMs is in future", () => {
      expect(decide({ ...beforeFirstRun, intent: "scheduled", reason: "interval" })).toEqual({
        defer: true,
        reason: "not-due",
      });
    });

    it("does not defer interval wake when now >= nextDueMs", () => {
      expect(
        decide({
          intent: "scheduled",
          now: 100_001,
          nextDueMs: 100_000,
          lastRunStartedAtMs: 70_000,
          reason: "interval",
        }),
      ).toEqual({ defer: false });
    });
  });

  describe("event-driven wakes after a prior run (regression for #75436)", () => {
    it("defers exec-event wakes when now < nextDueMs", () => {
      expect(decide({ ...afterRun, source: "exec-event", reason: "exec-event" })).toEqual({
        defer: true,
        reason: "not-due",
      });
    });

    it("defers cron wakes when now < nextDueMs", () => {
      expect(decide({ ...afterRun, source: "cron", reason: "cron:morning-brief" })).toEqual({
        defer: true,
        reason: "not-due",
      });
    });

    it("defers hook wakes when now < nextDueMs", () => {
      expect(decide({ ...afterRun, source: "hook", reason: "hook:wake" })).toEqual({
        defer: true,
        reason: "not-due",
      });
    });

    it("defers acp spawn stream wakes when now < nextDueMs", () => {
      expect(decide({ ...afterRun, source: "acp-spawn", reason: "acp:spawn:stream" })).toEqual({
        defer: true,
        reason: "not-due",
      });
    });

    it("defers unknown wake reasons when now < nextDueMs", () => {
      expect(decide({ ...afterRun, source: "other", reason: "something-new" })).toEqual({
        defer: true,
        reason: "not-due",
      });
    });
  });

  describe("event-driven wakes before any prior run (bootstrap)", () => {
    it("does NOT defer the first exec-event wake (lets idle agent respond)", () => {
      expect(decide({ ...beforeFirstRun, source: "exec-event", reason: "exec-event" })).toEqual({
        defer: false,
      });
    });

    it("does NOT defer the first cron wake", () => {
      expect(decide({ ...beforeFirstRun, source: "cron", reason: "cron:job-x" })).toEqual({
        defer: false,
      });
    });

    it("does NOT defer the first hook wake", () => {
      expect(decide({ ...beforeFirstRun, source: "hook", reason: "hook:wake" })).toEqual({
        defer: false,
      });
    });
  });

  describe("min-spacing floor", () => {
    it("defers with 'min-spacing' when last run started within floor (post-cooldown race)", () => {
      // nextDueMs has just been crossed, but a run started ~10s ago — second
      // wake landed before the schedule advanced.
      expect(
        decide({
          source: "exec-event",
          now: 200_000,
          nextDueMs: 199_999,
          lastRunStartedAtMs: 200_000 - DEFAULT_MIN_WAKE_SPACING_MS + 100,
          reason: "exec-event",
        }),
      ).toEqual({ defer: true, reason: "min-spacing" });
    });

    it("does not defer when last run is older than min-spacing", () => {
      expect(
        decide({
          source: "exec-event",
          now: 200_000,
          nextDueMs: 199_999,
          lastRunStartedAtMs: 200_000 - DEFAULT_MIN_WAKE_SPACING_MS - 1,
          reason: "exec-event",
        }),
      ).toEqual({ defer: false });
    });

    it("respects override of minSpacingMs", () => {
      expect(
        decide({
          source: "exec-event",
          now: 200_000,
          nextDueMs: 199_999,
          lastRunStartedAtMs: 199_500, // 500ms ago
          minSpacingMs: 1_000,
          reason: "exec-event",
        }),
      ).toEqual({ defer: true, reason: "min-spacing" });
    });

    it("does not gate manual wakes on min-spacing", () => {
      expect(
        decide({
          intent: "manual",
          now: 200_000,
          nextDueMs: 100_000,
          lastRunStartedAtMs: 199_999,
          reason: "manual",
        }),
      ).toEqual({ defer: false });
    });
  });

  describe("flood guard", () => {
    it("defers with 'flood' when threshold runs land within window", () => {
      const now = 1_000_000;
      const recentRunStarts = [
        now - 50_000,
        now - 40_000,
        now - 30_000,
        now - 20_000,
        now - 10_000,
      ];
      expect(
        decide({
          source: "exec-event",
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - DEFAULT_MIN_WAKE_SPACING_MS - 1,
          recentRunStarts,
          reason: "exec-event",
        }),
      ).toEqual({ defer: true, reason: "flood" });
    });

    it("does not flood-defer when recent runs are spread outside window", () => {
      const now = 1_000_000;
      const recentRunStarts = [
        now - 300_000,
        now - 240_000,
        now - 180_000,
        now - 120_000,
        now - 65_000, // just outside default 60s window
      ];
      expect(
        decide({
          source: "exec-event",
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - DEFAULT_MIN_WAKE_SPACING_MS - 1,
          recentRunStarts,
          reason: "exec-event",
        }),
      ).toEqual({ defer: false });
    });

    it("does not flood-defer below threshold", () => {
      const now = 1_000_000;
      const recentRunStarts = [now - 30_000, now - 20_000, now - 10_000];
      expect(
        decide({
          source: "exec-event",
          now,
          nextDueMs: 0,
          lastRunStartedAtMs: now - DEFAULT_MIN_WAKE_SPACING_MS - 1,
          recentRunStarts,
          reason: "exec-event",
        }),
      ).toEqual({ defer: false });
    });
  });
});

describe("recordRunStart", () => {
  it("trims buffer to threshold + 1 entries", () => {
    const buffer: number[] = [];
    for (let i = 1; i <= DEFAULT_FLOOD_THRESHOLD + 5; i++) {
      recordRunStart(buffer, i);
    }
    expect(buffer.length).toBe(DEFAULT_FLOOD_THRESHOLD + 1);
    expect(buffer[buffer.length - 1]).toBe(DEFAULT_FLOOD_THRESHOLD + 5);
  });

  it("preserves insertion order", () => {
    const buffer: number[] = [];
    recordRunStart(buffer, 100);
    recordRunStart(buffer, 200);
    recordRunStart(buffer, 300);
    expect(buffer).toEqual([100, 200, 300]);
  });
});
