import { Routes } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { createDiscordDraftStream } from "./draft-stream.js";

describe("createDiscordDraftStream", () => {
  it("holds the first preview until minInitialChars is reached", async () => {
    const rest = {
      post: vi.fn(async () => ({ id: "m1" })),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const stream = createDiscordDraftStream({
      rest: rest as never,
      channelId: "c1",
      throttleMs: 250,
      minInitialChars: 5,
    });

    stream.update("hey");
    await stream.flush();

    expect(rest.post).not.toHaveBeenCalled();
    expect(stream.messageId()).toBeUndefined();
  });

  it("sends a reply preview, then edits the same message on later flushes", async () => {
    const rest = {
      post: vi.fn(async () => ({ id: "m1" })),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const stream = createDiscordDraftStream({
      rest: rest as never,
      channelId: "c1",
      throttleMs: 250,
      replyToMessageId: () => "  parent-1  ",
    });

    stream.update("first draft");
    await stream.flush();
    stream.update("second draft");
    await stream.flush();

    expect(rest.post).toHaveBeenCalledWith(Routes.channelMessages("c1"), {
      body: {
        content: "first draft",
        allowed_mentions: { parse: [] },
        message_reference: {
          message_id: "parent-1",
          fail_if_not_exists: false,
        },
      },
    });
    expect(rest.patch).toHaveBeenCalledWith(Routes.channelMessage("c1", "m1"), {
      body: { content: "second draft", allowed_mentions: { parse: [] } },
    });
    expect(stream.messageId()).toBe("m1");
  });

  it("suppresses mentions in preview creates and edits", async () => {
    const rest = {
      post: vi.fn(async () => ({ id: "m1" })),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const stream = createDiscordDraftStream({
      rest: rest as never,
      channelId: "c1",
      throttleMs: 250,
    });

    stream.update("working @everyone <@123>");
    await stream.flush();
    stream.update("still working @here");
    await stream.flush();

    expect(rest.post).toHaveBeenCalledWith(Routes.channelMessages("c1"), {
      body: {
        content: "working @everyone <@123>",
        allowed_mentions: { parse: [] },
      },
    });
    expect(rest.patch).toHaveBeenCalledWith(Routes.channelMessage("c1", "m1"), {
      body: {
        content: "still working @here",
        allowed_mentions: { parse: [] },
      },
    });
  });

  it("stops previewing and warns once text exceeds the configured limit", async () => {
    const rest = {
      post: vi.fn(async () => ({ id: "m1" })),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const warn = vi.fn();
    const stream = createDiscordDraftStream({
      rest: rest as never,
      channelId: "c1",
      maxChars: 5,
      throttleMs: 250,
      warn,
    });

    stream.update("123456");
    await stream.flush();

    expect(rest.post).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("discord stream preview stopped"));
    expect(stream.messageId()).toBeUndefined();
  });

  it("discardPending keeps an existing preview but ignores later updates", async () => {
    const rest = {
      post: vi.fn(async () => ({ id: "m1" })),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const stream = createDiscordDraftStream({
      rest: rest as never,
      channelId: "c1",
      throttleMs: 250,
    });

    stream.update("first draft");
    await stream.flush();
    await stream.discardPending();
    stream.update("late draft");
    await stream.flush();

    expect(rest.post).toHaveBeenCalledTimes(1);
    expect(rest.patch).not.toHaveBeenCalled();
    expect(rest.delete).not.toHaveBeenCalled();
    expect(stream.messageId()).toBe("m1");
  });

  it("seal keeps an existing preview and cancels pending final overwrites", async () => {
    const rest = {
      post: vi.fn(async () => ({ id: "m1" })),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const stream = createDiscordDraftStream({
      rest: rest as never,
      channelId: "c1",
      throttleMs: 250,
    });

    stream.update("first draft");
    await stream.flush();
    stream.update("stale final draft");
    await stream.seal();

    expect(rest.post).toHaveBeenCalledTimes(1);
    expect(rest.patch).not.toHaveBeenCalled();
    expect(stream.messageId()).toBe("m1");
  });
});
