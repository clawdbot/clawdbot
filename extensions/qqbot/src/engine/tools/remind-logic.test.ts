import { describe, expect, it } from "vitest";
import {
  parseRelativeTime,
  isCronExpression,
  formatDelay,
  generateJobName,
  buildReminderPrompt,
  executeRemind,
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
    it("returns list instruction", () => {
      const result = executeRemind({ action: "list" });
      expect(result.details).toEqual({
        _instruction: expect.any(String),
        cronParams: { action: "list" },
      });
    });

    it("returns error when removing without jobId", () => {
      const result = executeRemind({ action: "remove" });
      expect((result.details as { error: string }).error).toContain("jobId");
    });

    it("returns error when content is missing for add", () => {
      const result = executeRemind({ action: "add", to: "qqbot:c2c:123", time: "5m" });
      expect((result.details as { error: string }).error).toContain("content");
    });

    it("returns error when delay is too short", () => {
      const result = executeRemind({
        action: "add",
        content: "test",
        to: "qqbot:c2c:123",
        time: "10s",
      });
      expect((result.details as { error: string }).error).toContain("30 seconds");
    });

    it("builds once job with delivery envelope for relative time", () => {
      const result = executeRemind({
        action: "add",
        content: "test reminder",
        to: "qqbot:c2c:123",
        time: "5m",
      });
      const details = result.details as {
        cronParams: {
          job: {
            schedule: { kind: string };
            payload: { kind: string; message: string };
            delivery: { mode: string; channel: string; to: string; accountId: string };
          };
        };
      };
      expect(details.cronParams.job.schedule.kind).toBe("at");
      expect(details.cronParams.job.payload.kind).toBe("agentTurn");
      expect(details.cronParams.job.delivery).toEqual({
        mode: "announce",
        channel: "qqbot",
        to: "qqbot:c2c:123",
        accountId: "default",
      });
    });

    it("builds cron job with delivery envelope for cron expression", () => {
      const result = executeRemind({
        action: "add",
        content: "test reminder",
        to: "qqbot:c2c:123",
        time: "0 8 * * *",
      });
      const details = result.details as {
        cronParams: {
          job: {
            schedule: { kind: string };
            delivery: { channel: string; to: string; accountId: string };
          };
        };
      };
      expect(details.cronParams.job.schedule.kind).toBe("cron");
      expect(details.cronParams.job.delivery.to).toBe("qqbot:c2c:123");
    });

    it("falls back to ctx.fallbackTo when to is omitted", () => {
      const result = executeRemind(
        { action: "add", content: "test", time: "5m" },
        { fallbackTo: "qqbot:c2c:ctx-target", fallbackAccountId: "alt" },
      );
      const details = result.details as {
        cronParams: { job: { delivery: { to: string; accountId: string } } };
      };
      expect(details.cronParams.job.delivery.to).toBe("qqbot:c2c:ctx-target");
      expect(details.cronParams.job.delivery.accountId).toBe("alt");
    });

    it("prefers AI-supplied to over ctx fallback", () => {
      const result = executeRemind(
        { action: "add", content: "test", time: "5m", to: "qqbot:group:ai-chosen" },
        { fallbackTo: "qqbot:c2c:ctx-target", fallbackAccountId: "alt" },
      );
      const details = result.details as {
        cronParams: { job: { delivery: { to: string; accountId: string } } };
      };
      expect(details.cronParams.job.delivery.to).toBe("qqbot:group:ai-chosen");
      expect(details.cronParams.job.delivery.accountId).toBe("alt");
    });

    it("returns error when neither AI nor ctx provides a target", () => {
      const result = executeRemind({ action: "add", content: "test", time: "5m" });
      expect((result.details as { error: string }).error).toMatch(/delivery target/i);
    });
  });
});
