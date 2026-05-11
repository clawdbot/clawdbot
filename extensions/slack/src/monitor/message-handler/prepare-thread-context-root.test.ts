import { describe, expect, it } from "vitest";
import {
  applySlackThreadHistoryFilterPolicy,
  ensureSlackThreadHistoryHasBotRoot,
  formatSlackBotStarterThreadLabel,
  isSlackThreadAuthorCurrentBot,
  resolveSlackThreadHistoryFilterPolicy,
  type SlackThreadRootCandidate,
  shouldIncludeBotThreadStarterContext,
} from "./prepare-thread-context-root.js";

describe("isSlackThreadAuthorCurrentBot", () => {
  const identity = { botUserId: "U_BOT", botId: "B1" };

  it("matches the configured bot user id", () => {
    expect(
      isSlackThreadAuthorCurrentBot({
        identity,
        author: { userId: "U_BOT" },
      }),
    ).toBe(true);
  });

  it("matches the configured bot id", () => {
    expect(
      isSlackThreadAuthorCurrentBot({
        identity,
        author: { botId: "B1" },
      }),
    ).toBe(true);
  });

  it("does not match a different bot id", () => {
    expect(
      isSlackThreadAuthorCurrentBot({
        identity,
        author: { botId: "B2" },
      }),
    ).toBe(false);
  });

  it("does not match a regular user", () => {
    expect(
      isSlackThreadAuthorCurrentBot({
        identity,
        author: { userId: "U1" },
      }),
    ).toBe(false);
  });

  it("returns false when identity has no bot ids", () => {
    expect(
      isSlackThreadAuthorCurrentBot({
        identity: {},
        author: { userId: "U_BOT", botId: "B1" },
      }),
    ).toBe(false);
  });
});

describe("resolveSlackThreadHistoryFilterPolicy", () => {
  it("retains only the current-bot root when starting a new session with starter text", () => {
    expect(
      resolveSlackThreadHistoryFilterPolicy({
        includeBotStarterAsRootContext: true,
        starterTs: "1",
      }),
    ).toEqual({ retainCurrentBotRootTs: "1" });
  });

  it("filters current-bot messages on existing sessions", () => {
    expect(
      resolveSlackThreadHistoryFilterPolicy({
        includeBotStarterAsRootContext: false,
        starterTs: "1",
      }),
    ).toEqual({});
  });
});

describe("applySlackThreadHistoryFilterPolicy", () => {
  const identity = { botUserId: "U_BOT", botId: "B1" };

  it("keeps only the current-bot root when policy names the root timestamp", () => {
    const history = [
      { ts: "1", botId: "B1", text: "bot root" },
      { ts: "1.5", botId: "B1", text: "assistant reply" },
      { ts: "2", userId: "U1", text: "user reply" },
    ];
    const result = applySlackThreadHistoryFilterPolicy({
      history,
      policy: { retainCurrentBotRootTs: "1" },
      identity,
    });
    expect(result.kept.map((entry) => entry.ts)).toEqual(["1", "2"]);
    expect(result.omittedCurrentBot).toBe(1);
  });

  it("filters current-bot messages and reports counts when policy excludes them", () => {
    const history = [
      { ts: "1", botId: "B1", text: "bot root" },
      { ts: "2", userId: "U_BOT", text: "bot via user id" },
      { ts: "3", userId: "U1", text: "user reply" },
      { ts: "4", botId: "B2", text: "third-party bot" },
    ];
    const result = applySlackThreadHistoryFilterPolicy({
      history,
      policy: {},
      identity,
    });
    expect(result.kept.map((entry) => entry.ts)).toEqual(["3", "4"]);
    expect(result.omittedCurrentBot).toBe(2);
  });

  it("returns an empty result for empty history", () => {
    const result = applySlackThreadHistoryFilterPolicy({
      history: [] as Array<{ ts: string; userId?: string; botId?: string }>,
      policy: {},
      identity,
    });
    expect(result.kept).toEqual([]);
    expect(result.omittedCurrentBot).toBe(0);
  });
});

describe("shouldIncludeBotThreadStarterContext", () => {
  it("includes when starter is bot, session is new, and starter has text", () => {
    expect(
      shouldIncludeBotThreadStarterContext({
        starterIsCurrentBot: true,
        isNewThreadSession: true,
        hasStarterText: true,
      }),
    ).toBe(true);
  });

  it("does not include when starter is not the current bot", () => {
    expect(
      shouldIncludeBotThreadStarterContext({
        starterIsCurrentBot: false,
        isNewThreadSession: true,
        hasStarterText: true,
      }),
    ).toBe(false);
  });

  it("does not include when session is not new", () => {
    expect(
      shouldIncludeBotThreadStarterContext({
        starterIsCurrentBot: true,
        isNewThreadSession: false,
        hasStarterText: true,
      }),
    ).toBe(false);
  });

  it("does not include when starter has no text", () => {
    expect(
      shouldIncludeBotThreadStarterContext({
        starterIsCurrentBot: true,
        isNewThreadSession: true,
        hasStarterText: false,
      }),
    ).toBe(false);
  });
});

describe("ensureSlackThreadHistoryHasBotRoot", () => {
  it("keeps the fetched root when history already contains it", () => {
    const history = [
      { ts: "1", botId: "B1", text: "bot root" },
      { ts: "2", userId: "U1", text: "user reply" },
    ];
    expect(
      ensureSlackThreadHistoryHasBotRoot({
        history,
        includeBotStarterAsRootContext: true,
        threadStarter: { ts: "1", botId: "B1", text: "bot root" },
      }),
    ).toBe(history);
  });

  it("prepends the starter root when fetched history omitted it", () => {
    const history: SlackThreadRootCandidate[] = [{ ts: "2", userId: "U1", text: "user reply" }];
    expect(
      ensureSlackThreadHistoryHasBotRoot({
        history,
        includeBotStarterAsRootContext: true,
        threadStarter: { ts: "1", botId: "B1", text: "bot root" },
      }).map((entry) => entry.text),
    ).toEqual(["bot root", "user reply"]);
  });

  it("does not inject when bot starter root context is disabled", () => {
    const history: SlackThreadRootCandidate[] = [{ ts: "2", userId: "U1", text: "user reply" }];
    expect(
      ensureSlackThreadHistoryHasBotRoot({
        history,
        includeBotStarterAsRootContext: false,
        threadStarter: { ts: "1", botId: "B1", text: "bot root" },
      }).map((entry) => entry.text),
    ).toEqual(["user reply"]);
  });
});

describe("formatSlackBotStarterThreadLabel", () => {
  it("returns base label when starter text is missing", () => {
    expect(formatSlackBotStarterThreadLabel({ roomLabel: "DM" })).toBe("Slack thread DM");
  });

  it("returns base label when starter text is empty", () => {
    expect(formatSlackBotStarterThreadLabel({ roomLabel: "DM", starterText: "" })).toBe(
      "Slack thread DM",
    );
  });

  it("returns base label when starter text collapses to whitespace snippet", () => {
    expect(formatSlackBotStarterThreadLabel({ roomLabel: "DM", starterText: "   " })).toBe(
      "Slack thread DM",
    );
  });

  it("appends an assistant root snippet to the room label", () => {
    expect(
      formatSlackBotStarterThreadLabel({
        roomLabel: "#general",
        starterText: "Confirmed meeting at noon",
      }),
    ).toBe("Slack thread #general (assistant root): Confirmed meeting at noon");
  });

  it("truncates long starter text to 80 characters", () => {
    const longText = "x".repeat(120);
    const label = formatSlackBotStarterThreadLabel({ roomLabel: "DM", starterText: longText });
    expect(label.endsWith("x".repeat(80))).toBe(true);
  });

  it("collapses internal whitespace", () => {
    expect(
      formatSlackBotStarterThreadLabel({
        roomLabel: "DM",
        starterText: "Line one\n\nLine two",
      }),
    ).toBe("Slack thread DM (assistant root): Line one Line two");
  });
});
