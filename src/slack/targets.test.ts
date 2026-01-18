import { describe, expect, it } from "vitest";

import { normalizeSlackMessagingTarget } from "../channels/plugins/normalize/slack.js";
import { parseSlackTarget, resolveSlackChannelId } from "./targets.js";

describe("parseSlackTarget", () => {
  it("parses user mentions and prefixes", () => {
    expect(parseSlackTarget("<@U123>")).toMatchObject({
      kind: "user",
      id: "U123",
      normalized: "user:u123",
    });
    expect(parseSlackTarget("user:U456")).toMatchObject({
      kind: "user",
      id: "U456",
      normalized: "user:u456",
    });
    expect(parseSlackTarget("slack:U789")).toMatchObject({
      kind: "user",
      id: "U789",
      normalized: "user:u789",
    });
  });

  it("parses channel targets", () => {
    expect(parseSlackTarget("channel:C123")).toMatchObject({
      kind: "channel",
      id: "C123",
      normalized: "channel:c123",
    });
    expect(parseSlackTarget("#C999")).toMatchObject({
      kind: "channel",
      id: "C999",
      normalized: "channel:c999",
    });
  });

  it("rejects invalid @ and # targets", () => {
    expect(() => parseSlackTarget("@bob-1")).toThrow(/Slack DMs require a user id/);
    expect(() => parseSlackTarget("#general-1")).toThrow(/Slack channels require a channel id/);
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
});

describe("normalizeSlackMessagingTarget", () => {
  it("defaults raw ids to channels", () => {
    expect(normalizeSlackMessagingTarget("C123")).toBe("channel:c123");
  });
});
