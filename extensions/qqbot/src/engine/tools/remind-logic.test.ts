import { describe, expect, it } from "vitest";
import {
  parseRelativeTime,
  isCronExpression,
  formatDelay,
  generateJobName,
  buildReminderPrompt,
  executeRemind,
  executeScheduledRemind,
  prepareRemindCronAction,
  type RemindCronAction,
} from "./remind-logic.js";

describe("engine/tools/remind-logic", () => {
  describe("parseRelativeTime", () => {
    it("parses minutes shorthand", () => {
      expect(parseRelativeTime("5m")).toBe(5 * 60_000);
    });

    it("parses hours shorthand", () => {
      expect(parseRelativeTime("1h")).toBe(3_600_000);
    });

    it("parses combined hours and minutes", () => {
      expect(parseRelativeTime("1h30m")).toBe(90 * 60_000);
    });

    it("parses days", () => {
      expect(parseRelativeTime("2d")).toBe(2 * 86_400_000);
    });

    it("parses seconds", () => {
      expect(parseRelativeTime("45s")).toBe(45_000);
    });

    it("treats plain numbers as minutes", () => {
      expect(parseRelativeTime("10")).toBe(10 * 60_000);
    });

    it("returns null for unparseable input", () => {
      expect(parseRelativeTime("never")).toBeNull();
    });

    it("is case insensitive", () => {
      expect(parseRelativeTime("5M")).toBe(5 * 60_000);
    });
  });

  describe("isCronExpression", () => {
    it("detects standard 5-field cron", () => {
      expect(isCronExpression("0 8 * * *")).toBe(true);
    });

    it("detects weekday range cron", () => {
      expect(isCronExpression("0 9 * * 1-5")).toBe(true);
    });

    it("rejects short input", () => {
      expect(isCronExpression("5m")).toBe(false);
    });

    it("rejects too many fields", () => {
      expect(isCronExpression("0 0 0 0 0 0 0")).toBe(false);
    });
  });

  describe("formatDelay", () => {
    it("formats seconds", () => {
      expect(formatDelay(45_000)).toBe("45s");
    });

    it("formats minutes", () => {
      expect(formatDelay(300_000)).toBe("5m");
    });

    it("formats hours", () => {
      expect(formatDelay(3_600_000)).toBe("1h");
    });

    it("formats hours and minutes", () => {
      expect(formatDelay(5_400_000)).toBe("1h30m");
    });
  });

  describe("generateJobName", () => {
    it("returns short content as-is", () => {
      expect(generateJobName("drink water")).toBe("Reminder: drink water");
    });

    it("truncates long content", () => {
      const long = "a very long reminder content that exceeds twenty characters";
      const name = generateJobName(long);
      expect(name.length).toBeLessThan(40);
      expect(name).toContain("…");
    });
  });

  describe("buildReminderPrompt", () => {
    it("includes the content in the prompt", () => {
      const prompt = buildReminderPrompt("drink water");
      expect(prompt).toContain("drink water");
    });
  });

  describe("executeRemind", () => {
    it("renders internal scheduling output without exposing cronParams", () => {
      const result = executeRemind({ action: "list" });
      expect(result.details).toEqual({
        _instruction: "Gateway cron action prepared for internal QQ reminder scheduling.",
        action: "list",
        summary: undefined,
      });
      expect((result.details as { _instruction: string })._instruction).not.toContain(
        "Use the cron tool",
      );
      expect(result.details).not.toHaveProperty("cronParams");
    });
  });

  describe("prepareRemindCronAction", () => {
    it("returns error when removing without jobId", () => {
      const result = prepareRemindCronAction({ action: "remove" });
      expect(result).toEqual({
        ok: false,
        error: "jobId is required when action=remove. Use action=list first.",
      });
    });

    it("returns error when content is missing for add", () => {
      const result = prepareRemindCronAction({ action: "add", to: "qqbot:c2c:123", time: "5m" });
      expect(result).toEqual({ ok: false, error: "content is required when action=add" });
    });

    it("returns error when delay is too short", () => {
      const result = prepareRemindCronAction({
        action: "add",
        content: "test",
        to: "qqbot:c2c:123",
        time: "10s",
      });
      expect(result).toEqual({ ok: false, error: "Reminder delay must be at least 30 seconds" });
    });

    it("builds once job with delivery envelope for relative time", () => {
      const result = prepareRemindCronAction({
        action: "add",
        content: "test reminder",
        to: "qqbot:c2c:123",
        time: "5m",
      });
      expect(result.ok).toBe(true);
      expect(result.ok ? result.cronAction.action : undefined).toBe("add");
      const job = result.ok && result.cronAction.action === "add" ? result.cronAction.job : null;
      expect(job?.schedule.kind).toBe("at");
      expect(job?.payload.kind).toBe("agentTurn");
      expect(job?.delivery).toEqual({
        mode: "announce",
        channel: "qqbot",
        to: "qqbot:c2c:123",
        accountId: "default",
      });
    });

    it("builds cron job with delivery envelope for cron expression", () => {
      const result = prepareRemindCronAction({
        action: "add",
        content: "test reminder",
        to: "qqbot:c2c:123",
        time: "0 8 * * *",
      });
      expect(result.ok).toBe(true);
      const job = result.ok && result.cronAction.action === "add" ? result.cronAction.job : null;
      expect(job?.schedule.kind).toBe("cron");
      expect(job?.delivery.to).toBe("qqbot:c2c:123");
    });

    it("falls back to ctx.fallbackTo when to is omitted", () => {
      const result = prepareRemindCronAction(
        { action: "add", content: "test", time: "5m" },
        { fallbackTo: "qqbot:c2c:ctx-target", fallbackAccountId: "alt" },
      );
      expect(result.ok).toBe(true);
      const job = result.ok && result.cronAction.action === "add" ? result.cronAction.job : null;
      expect(job?.delivery.to).toBe("qqbot:c2c:ctx-target");
      expect(job?.delivery.accountId).toBe("alt");
    });

    it("prefers AI-supplied to over ctx fallback", () => {
      const result = prepareRemindCronAction(
        { action: "add", content: "test", time: "5m", to: "qqbot:group:ai-chosen" },
        { fallbackTo: "qqbot:c2c:ctx-target", fallbackAccountId: "alt" },
      );
      expect(result.ok).toBe(true);
      const job = result.ok && result.cronAction.action === "add" ? result.cronAction.job : null;
      expect(job?.delivery.to).toBe("qqbot:group:ai-chosen");
      expect(job?.delivery.accountId).toBe("alt");
    });

    it("returns error when neither AI nor ctx provides a target", () => {
      const result = prepareRemindCronAction({ action: "add", content: "test", time: "5m" });
      expect(result).toEqual({
        ok: false,
        error:
          "Unable to determine delivery target for action=add. " +
          "The reminder can only be scheduled from within an active conversation.",
      });
    });
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
      expect(call.job.schedule.atMs).toBeGreaterThanOrEqual(before + 5 * 60_000);
      expect(call.job.schedule.atMs).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 1_000);
      expect(call.job.sessionTarget).toBe("isolated");
      expect(call.job.wakeMode).toBe("now");
      expect(call.job.deleteAfterRun).toBe(true);
      expect(call.job.payload).toEqual({
        kind: "agentTurn",
        message: buildReminderPrompt("test reminder"),
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
  });
});
