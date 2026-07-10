// Slack tests cover targets plugin behavior.
import { describe, expect, it } from "vitest";
import { canonicalizeSlackApiTargetId } from "./target-parsing.js";
import {
  normalizeSlackMessagingTarget,
  parseSlackTarget,
  resolveSlackChannelId,
  slackContextTargetsMatch,
  slackTargetsMatch,
} from "./targets.js";

describe("parseSlackTarget", () => {
  it("parses user mentions and prefixes", () => {
    const cases = [
      { input: "<@U123>", id: "U123", normalized: "user:u123" },
      { input: "user:U456", id: "U456", normalized: "user:u456" },
      { input: "slack:U789", id: "U789", normalized: "user:u789" },
      { input: "U2ZH3MFSR", id: "U2ZH3MFSR", normalized: "user:u2zh3mfsr" },
      { input: "u09g2dj0275", id: "u09g2dj0275", normalized: "user:u09g2dj0275" },
      { input: "W2ZH3MFSR", id: "W2ZH3MFSR", normalized: "user:w2zh3mfsr" },
      { input: "w09g2dj0275", id: "w09g2dj0275", normalized: "user:w09g2dj0275" },
    ] as const;
    for (const testCase of cases) {
      expect(parseSlackTarget(testCase.input), testCase.input).toEqual({
        kind: "user",
        id: testCase.id,
        raw: testCase.input,
        normalized: testCase.normalized,
      });
    }
  });

  it("parses channel targets", () => {
    const cases = [
      { input: "channel:C123", id: "C123", normalized: "channel:c123" },
      { input: "#C999", id: "C999", normalized: "channel:c999" },
      { input: "updates", id: "updates", normalized: "channel:updates" },
      { input: "workspace", id: "workspace", normalized: "channel:workspace" },
    ] as const;
    for (const testCase of cases) {
      expect(parseSlackTarget(testCase.input), testCase.input).toEqual({
        kind: "channel",
        id: testCase.id,
        raw: testCase.input,
        normalized: testCase.normalized,
      });
    }
  });

  it("rejects invalid @ and # targets", () => {
    const cases = [
      { input: "@bob-1", expectedMessage: /Slack DMs require a user id/ },
      { input: "#general-1", expectedMessage: /Slack channels require a channel id/ },
    ] as const;
    for (const testCase of cases) {
      expect(() => parseSlackTarget(testCase.input), testCase.input).toThrow(
        testCase.expectedMessage,
      );
    }
  });
});

describe("resolveSlackChannelId", () => {
  it("strips channel: prefix and accepts raw ids", () => {
    expect(resolveSlackChannelId("channel:C123")).toBe("C123");
    expect(resolveSlackChannelId("C123")).toBe("C123");
  });

  it("rejects user targets", () => {
    expect(() => resolveSlackChannelId("user:U123")).toThrow(/channel id is required/i);
  });

  it("restores canonical case for structurally known channel ids", () => {
    expect(resolveSlackChannelId("channel:c08gqh53ejm")).toBe("C08GQH53EJM");
  });

  it.each(["companychat", "channel:companychat", "#companychat", "#c08gqh53ejm"])(
    "preserves the channel name %s",
    (target) => {
      expect(resolveSlackChannelId(target)).toBe(target.replace(/^(?:channel:|#)/, ""));
    },
  );
});

describe("Slack API target ids", () => {
  it.each([
    { kind: "channel" as const, id: "c08gqh53ejm", expected: "C08GQH53EJM" },
    { kind: "channel" as const, id: "d08gqh53ejm", expected: "D08GQH53EJM" },
    { kind: "channel" as const, id: "g08gqh53ejm", expected: "G08GQH53EJM" },
    { kind: "user" as const, id: "u09g2dj0275", expected: "U09G2DJ0275" },
    { kind: "user" as const, id: "w09g2dj0275", expected: "W09G2DJ0275" },
  ])("canonicalizes a proven $kind id", ({ kind, id, expected }) => {
    expect(canonicalizeSlackApiTargetId(kind, id)).toBe(expected);
  });

  it.each([
    { id: "companychat", expected: "companychat" },
    { id: "team:T123:channel:C08GQH53EJM", expected: "team:T123:channel:C08GQH53EJM" },
  ])("preserves an ambiguous channel target $id", ({ id, expected }) => {
    expect(canonicalizeSlackApiTargetId("channel", id)).toBe(expected);
  });
});

describe("normalizeSlackMessagingTarget", () => {
  it("defaults raw ids to channels", () => {
    expect(normalizeSlackMessagingTarget("C123")).toBe("channel:c123");
  });
});

describe("slackTargetsMatch", () => {
  it("matches equivalent channel and user targets", () => {
    expect(slackTargetsMatch("channel:C123", "C123")).toBe(true);
    expect(slackTargetsMatch("user:U123", "slack:U123")).toBe(true);
  });

  it("does not match different target kinds", () => {
    expect(slackTargetsMatch("user:U123", "channel:U123")).toBe(false);
  });
});

describe("slackContextTargetsMatch", () => {
  it("matches resolved bare user ids against the routable DM target", () => {
    const context = {
      currentChannelId: "D123",
      currentMessagingTarget: "user:U123",
    };

    expect(slackContextTargetsMatch("U123", context)).toBe(true);
    expect(
      slackContextTargetsMatch("W123", {
        ...context,
        currentMessagingTarget: "user:W123",
      }),
    ).toBe(true);
    expect(slackContextTargetsMatch("U999", context)).toBe(false);
    expect(slackContextTargetsMatch("C123", context)).toBe(false);
  });
});
