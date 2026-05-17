import { describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { resolveGroupSessionKey } from "./group.js";

describe("resolveGroupSessionKey", () => {
  it("preserves Signal group ids from the originating target", () => {
    const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    const ctx = {
      Provider: "signal",
      ChatType: "group",
      From: "signal:+15551234567",
      OriginatingTo: `signal:group:${mixedGroupId}`,
    } satisfies Partial<MsgContext>;

    expect(resolveGroupSessionKey(ctx as MsgContext)).toEqual({
      key: `signal:group:${mixedGroupId}`,
      channel: "signal",
      id: mixedGroupId,
      chatType: "group",
    });
  });

  it("keeps non-Signal group ids lowercase", () => {
    const ctx = {
      Provider: "telegram",
      ChatType: "group",
      From: "telegram:1234",
      OriginatingTo: "telegram:group:MiXeDGroup",
    } satisfies Partial<MsgContext>;

    expect(resolveGroupSessionKey(ctx as MsgContext)).toEqual({
      key: "telegram:group:mixedgroup",
      channel: "telegram",
      id: "mixedgroup",
      chatType: "group",
    });
  });
});
