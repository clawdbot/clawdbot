import { describe, expect, it, vi } from "vitest";

import type { MoltbotConfig } from "../../config/config.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "../tokens.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { createReplyToModeFilter, resolveReplyToMode } from "./reply-threading.js";

const emptyCfg = {} as MoltbotConfig;

describe("createReplyDispatcher", () => {
  it("drops empty payloads and silent tokens without media", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({ deliver });

    expect(dispatcher.sendFinalReply({})).toBe(false);
    expect(dispatcher.sendFinalReply({ text: " " })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: SILENT_REPLY_TOKEN })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: `${SILENT_REPLY_TOKEN} -- nope` })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: `interject.${SILENT_REPLY_TOKEN}` })).toBe(false);

    await dispatcher.waitForIdle();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("strips heartbeat tokens and applies responsePrefix", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const onHeartbeatStrip = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver,
      responsePrefix: "PFX",
      onHeartbeatStrip,
    });

    expect(dispatcher.sendFinalReply({ text: HEARTBEAT_TOKEN })).toBe(false);
    expect(dispatcher.sendToolResult({ text: `${HEARTBEAT_TOKEN} hello` })).toBe(true);
    await dispatcher.waitForIdle();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].text).toBe("PFX hello");
    expect(onHeartbeatStrip).toHaveBeenCalledTimes(2);
  });

  it("avoids double-prefixing and keeps media when heartbeat is the only text", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      responsePrefix: "PFX",
    });

    expect(
      dispatcher.sendFinalReply({
        text: "PFX already",
        mediaUrl: "file:///tmp/photo.jpg",
      }),
    ).toBe(true);
    expect(
      dispatcher.sendFinalReply({
        text: HEARTBEAT_TOKEN,
        mediaUrl: "file:///tmp/photo.jpg",
      }),
    ).toBe(true);
    expect(
      dispatcher.sendFinalReply({
        text: `${SILENT_REPLY_TOKEN} -- explanation`,
        mediaUrl: "file:///tmp/photo.jpg",
      }),
    ).toBe(true);

    await dispatcher.waitForIdle();

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliver.mock.calls[0][0].text).toBe("PFX already");
    expect(deliver.mock.calls[1][0].text).toBe("");
    expect(deliver.mock.calls[2][0].text).toBe("");
  });

  it("preserves ordering across tool, block, and final replies", async () => {
    const delivered: string[] = [];
    const deliver = vi.fn(async (_payload, info) => {
      delivered.push(info.kind);
      if (info.kind === "tool") {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    const dispatcher = createReplyDispatcher({ deliver });

    dispatcher.sendToolResult({ text: "tool" });
    dispatcher.sendBlockReply({ text: "block" });
    dispatcher.sendFinalReply({ text: "final" });

    await dispatcher.waitForIdle();
    expect(delivered).toEqual(["tool", "block", "final"]);
  });

  it("fires onIdle when the queue drains", async () => {
    const deliver = vi.fn(async () => await new Promise((resolve) => setTimeout(resolve, 5)));
    const onIdle = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver, onIdle });

    dispatcher.sendToolResult({ text: "one" });
    dispatcher.sendFinalReply({ text: "two" });

    await dispatcher.waitForIdle();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("delays block replies after the first when humanDelay is natural", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      humanDelay: { mode: "natural" },
    });

    dispatcher.sendBlockReply({ text: "first" });
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);

    dispatcher.sendBlockReply({ text: "second" });
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(799);
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledTimes(2);

    randomSpy.mockRestore();
    vi.useRealTimers();
  });

  it("uses custom bounds for humanDelay and clamps when max <= min", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      humanDelay: { mode: "custom", minMs: 1200, maxMs: 400 },
    });

    dispatcher.sendBlockReply({ text: "first" });
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);

    dispatcher.sendBlockReply({ text: "second" });
    await vi.advanceTimersByTimeAsync(1199);
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

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
    } as MoltbotConfig;
    expect(resolveReplyToMode(cfg, "telegram")).toBe("all");
    expect(resolveReplyToMode(cfg, "discord")).toBe("first");
    expect(resolveReplyToMode(cfg, "slack")).toBe("all");
  });

  it("uses chat-type replyToMode overrides for Slack when configured", () => {
    const cfg = {
      channels: {
        slack: {
          replyToMode: "off",
          replyToModeByChatType: { direct: "all", group: "first" },
        },
      },
    } as MoltbotConfig;
    expect(resolveReplyToMode(cfg, "slack", null, "direct")).toBe("all");
    expect(resolveReplyToMode(cfg, "slack", null, "group")).toBe("first");
    expect(resolveReplyToMode(cfg, "slack", null, "channel")).toBe("off");
    expect(resolveReplyToMode(cfg, "slack", null, undefined)).toBe("off");
  });

  it("falls back to top-level replyToMode when no chat-type override is set", () => {
    const cfg = {
      channels: {
        slack: {
          replyToMode: "first",
        },
      },
    } as MoltbotConfig;
    expect(resolveReplyToMode(cfg, "slack", null, "direct")).toBe("first");
    expect(resolveReplyToMode(cfg, "slack", null, "channel")).toBe("first");
  });

  it("uses legacy dm.replyToMode for direct messages when no chat-type override exists", () => {
    const cfg = {
      channels: {
        slack: {
          replyToMode: "off",
          dm: { replyToMode: "all" },
        },
      },
    } as MoltbotConfig;
    expect(resolveReplyToMode(cfg, "slack", null, "direct")).toBe("all");
    expect(resolveReplyToMode(cfg, "slack", null, "channel")).toBe("off");
  });
});

describe("createReplyToModeFilter", () => {
  it("drops replyToId when mode is off", () => {
    const filter = createReplyToModeFilter("off");
    expect(filter({ text: "hi", replyToId: "1" }).replyToId).toBeUndefined();
  });

  it("keeps replyToId when mode is off and reply tags are allowed", () => {
    const filter = createReplyToModeFilter("off", { allowTagsWhenOff: true });
    expect(filter({ text: "hi", replyToId: "1", replyToTag: true }).replyToId).toBe("1");
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
