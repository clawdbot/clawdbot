// Qqbot tests cover remind logic plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeScheduledRemind, type RemindCronAction } from "./remind-logic.js";

describe("engine/tools/remind-logic", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("executeScheduledRemind", () => {
    it("runs cron.add directly for relative reminders", async () => {
      const calls: RemindCronAction[] = [];
      const before = Date.now();
      const result = await executeScheduledRemind(
        { action: "add", content: "test reminder", to: "qqbot:c2c:123", time: "5m" },
        {},
        async (params) => {
          calls.push(params);
          return { id: "job-1" };
        },
      );

      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call?.action).toBe("add");
      if (call?.action !== "add") {
        throw new Error("expected add cron action");
      }
      expect(call.job.name).toBe("Reminder: test reminder");
      expect(call.job.schedule.kind).toBe("at");
      if (call.job.schedule.kind !== "at") {
        throw new Error("expected at schedule");
      }
      if (!("deleteAfterRun" in call.job)) {
        throw new Error("expected one-shot reminder job");
      }
      const scheduledAtMs = Date.parse(call.job.schedule.at);
      expect(scheduledAtMs).toBeGreaterThanOrEqual(before + 5 * 60_000);
      expect(scheduledAtMs).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 1_000);
      expect(call.job.sessionTarget).toBe("isolated");
      expect(call.job.wakeMode).toBe("now");
      expect(call.job.deleteAfterRun).toBe(true);
      expect(call.job.payload).toEqual({
        kind: "agentTurn",
        message: expect.stringContaining("test reminder"),
        toolsAllow: [],
      });
      expect(call.job.delivery).toEqual({
        mode: "announce",
        channel: "qqbot",
        to: "qqbot:c2c:123",
        accountId: "default",
      });
      expect(result.details).toEqual({
        ok: true,
        action: "add",
        summary: '⏰ Reminder in 5m: "test reminder"',
        cronResult: { id: "job-1" },
      });
    });

    it.each([
      {
        name: "uses the Gateway timezone when omitted",
        timezone: undefined,
        expectedSchedule: { kind: "cron", expr: "0 9 * * *" },
        expectedSummary: '⏰ Recurring reminder: "test reminder" (0 9 * * *, tz=gateway local)',
      },
      {
        name: "preserves an explicit IANA timezone",
        timezone: " America/New_York ",
        expectedSchedule: {
          kind: "cron",
          expr: "0 9 * * *",
          tz: "America/New_York",
        },
        expectedSummary: '⏰ Recurring reminder: "test reminder" (0 9 * * *, tz=America/New_York)',
      },
    ])("$name for recurring reminders", async ({ timezone, expectedSchedule, expectedSummary }) => {
      const calls: RemindCronAction[] = [];
      const result = await executeScheduledRemind(
        {
          action: "add",
          content: "test reminder",
          to: "qqbot:c2c:123",
          time: "0 9 * * *",
          ...(timezone ? { timezone } : {}),
        },
        {},
        async (params) => {
          calls.push(params);
          return { id: "job-cron" };
        },
      );

      const call = calls[0];
      expect(call?.action).toBe("add");
      if (call?.action !== "add") {
        throw new Error("expected add cron action");
      }
      expect(call.job.schedule).toEqual(expectedSchedule);
      expect(result.details).toEqual({
        ok: true,
        action: "add",
        summary: expectedSummary,
        cronResult: { id: "job-cron" },
      });
    });

    it("runs cron list and remove through the scheduler", async () => {
      const calls: unknown[] = [];
      await executeScheduledRemind({ action: "list" }, {}, async (params) => {
        calls.push(params);
        return { jobs: [] };
      });
      await executeScheduledRemind({ action: "remove", jobId: "job-1" }, {}, async (params) => {
        calls.push(params);
        return { ok: true };
      });

      expect(calls).toEqual([{ action: "list" }, { action: "remove", jobId: "job-1" }]);
    });

    it("does not call scheduler when validation fails", async () => {
      const result = await executeScheduledRemind({ action: "add", time: "5m" }, {}, async () => {
        throw new Error("should not run");
      });

      expect((result.details as { error: string }).error).toContain("content");
    });

    it("returns a clear error when Gateway cron fails", async () => {
      const result = await executeScheduledRemind(
        { action: "remove", jobId: "job-1" },
        {},
        async () => {
          throw new Error("gateway unavailable");
        },
      );

      expect(result.details).toEqual({
        error: "Failed to run Gateway cron action: gateway unavailable",
        action: "remove",
      });
    });

    it("rejects relative reminders whose scheduled time exceeds the Date range", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(8_640_000_000_000_000));

      const result = await executeScheduledRemind(
        { action: "add", content: "test reminder", to: "qqbot:c2c:123", time: "5m" },
        {},
        async () => ({ id: "unexpected" }),
      );

      expect(result.details).toEqual({
        error: "Reminder time is outside the supported Date range",
      });
    });
  });
});
