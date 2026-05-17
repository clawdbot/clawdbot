import { describe, expect, it } from "vitest";
import { normalizeExplicitSessionKey } from "./explicit-session-key-normalization.js";
import { installDiscordSessionKeyNormalizerFixture, makeCtx } from "./session-key.test-helpers.js";

installDiscordSessionKeyNormalizerFixture();

describe("normalizeExplicitSessionKey", () => {
  it("dispatches discord keys through the provider normalizer", () => {
    expect(
      normalizeExplicitSessionKey(
        "agent:fina:discord:channel:123456",
        makeCtx({
          Surface: "discord",
          ChatType: "direct",
          From: "discord:123456",
          SenderId: "123456",
        }),
      ),
    ).toBe("agent:fina:discord:direct:123456");
  });

  it("infers the provider from From when explicit provider fields are absent", () => {
    expect(
      normalizeExplicitSessionKey(
        "discord:dm:123456",
        makeCtx({
          ChatType: "direct",
          From: "discord:123456",
          SenderId: "123456",
        }),
      ),
    ).toBe("discord:direct:123456");
  });

  it("uses Provider when Surface is absent", () => {
    expect(
      normalizeExplicitSessionKey(
        "agent:fina:discord:dm:123456",
        makeCtx({
          Provider: "Discord",
          ChatType: "direct",
          SenderId: "123456",
        }),
      ),
    ).toBe("agent:fina:discord:direct:123456");
  });

  it("lowercases and passes through unknown providers unchanged", () => {
    expect(
      normalizeExplicitSessionKey(
        "Agent:Fina:Slack:DM:ABC",
        makeCtx({
          Surface: "slack",
          From: "slack:U123",
        }),
      ),
    ).toBe("agent:fina:slack:dm:abc");
  });

  it("preserves Signal group ids when explicit session keys are canonicalized", () => {
    const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    expect(
      normalizeExplicitSessionKey(
        `Agent:Main:Signal:Group:${mixedGroupId}`,
        makeCtx({
          Provider: "signal",
          ChatType: "group",
          From: `signal:group:${mixedGroupId}`,
          OriginatingTo: `signal:group:${mixedGroupId}`,
        }),
      ),
    ).toBe(`agent:main:signal:group:${mixedGroupId}`);
  });
});
