import { describe, expect, it } from "vitest";

import { resolveSlackChannelConfig } from "./channel-config.js";

describe("resolveSlackChannelConfig", () => {
  it("uses defaultRequireMention when channels config is empty", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: {},
      defaultRequireMention: false,
    });
    expect(res).toEqual({ allowed: true, requireMention: false });
  });

  it("defaults defaultRequireMention to true when not provided", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: {},
    });
    expect(res).toEqual({ allowed: true, requireMention: true });
  });

  it("prefers explicit channel/fallback requireMention over defaultRequireMention", () => {
    const res = resolveSlackChannelConfig({
      channelId: "C1",
      channels: { "*": { requireMention: true } },
      defaultRequireMention: false,
    });
    expect(res).toMatchObject({ requireMention: true });
  });
});
