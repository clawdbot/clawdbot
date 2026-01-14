import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import {
  createReplyToModeFilter,
  resolveReplyToMode,
} from "./reply-threading.js";

const emptyCfg = {} as ClawdbotConfig;

describe("resolveReplyToMode", () => {
  it("defaults to first for Telegram", () => {
    expect(resolveReplyToMode(emptyCfg, "telegram")).toBe("first");
  });

  it("defaults to off for Discord and Slack", () => {
    expect(resolveReplyToMode(emptyCfg, "discord")).toBe("off");
    expect(resolveReplyToMode(emptyCfg, "slack")).toBe("off");
  });

  it("defaults to all when channel is unknown", () => {
    expect(resolveReplyToMode(emptyCfg, undefined)).toBe("all");
  });

  it("uses configured value when present", () => {
    const cfg = {
      channels: {
        telegram: { replyToMode: "all" },
        discord: { replyToMode: "first" },
        slack: { replyToMode: "all" },
      },
    } as ClawdbotConfig;
    expect(resolveReplyToMode(cfg, "telegram")).toBe("all");
    expect(resolveReplyToMode(cfg, "discord")).toBe("first");
    expect(resolveReplyToMode(cfg, "slack")).toBe("all");
  });
});

describe("createReplyToModeFilter", () => {
  it("drops replyToId when mode is off", () => {
    const filter = createReplyToModeFilter("off");
    expect(filter({ text: "hi", replyToId: "1" }).replyToId).toBeUndefined();
  });

  it("keeps replyToId when mode is off and reply tags are allowed", () => {
    const filter = createReplyToModeFilter("off", { allowTagsWhenOff: true });
    expect(
      filter({ text: "hi", replyToId: "1", replyToTag: true }).replyToId,
    ).toBe("1");
  });

  it("keeps replyToId when mode is all", () => {
    const filter = createReplyToModeFilter("all");
    expect(filter({ text: "hi", replyToId: "1" }).replyToId).toBe("1");
  });

  it("keeps only the first replyToId when mode is first", () => {
    const filter = createReplyToModeFilter("first");
    expect(filter({ text: "hi", replyToId: "1" }).replyToId).toBe("1");
    expect(filter({ text: "next", replyToId: "1" }).replyToId).toBeUndefined();
  });
});
