// Discord tests cover draft stream plugin behavior.
import { MessageFlags, Routes } from "discord-api-types/v10";
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

  it("deletes the current preview without stopping later draft updates", async () => {
    const rest = {
      post: vi.fn().mockResolvedValueOnce({ id: "m1" }).mockResolvedValueOnce({ id: "m2" }),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const stream = createDiscordDraftStream({
      rest: rest as never,
      channelId: "c1",
      throttleMs: 250,
    });

    stream.update("temporary commentary");
    await stream.flush();
    await stream.deleteCurrentMessage();
    stream.update("tool progress");
    await stream.flush();

    expect(rest.delete).toHaveBeenCalledWith(Routes.channelMessage("c1", "m1"));
    expect(rest.post).toHaveBeenNthCalledWith(2, Routes.channelMessages("c1"), {
      body: {
        content: "tool progress",
        allowed_mentions: { parse: [] },
      },
    });
    expect(rest.patch).not.toHaveBeenCalled();
    expect(stream.messageId()).toBe("m2");
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

  it("suppresses link embeds in preview creates and edits when requested", async () => {
    const rest = {
      post: vi.fn(async () => ({ id: "m1" })),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const stream = createDiscordDraftStream({
      rest: rest as never,
      channelId: "c1",
      throttleMs: 250,
      suppressEmbeds: true,
    });

    stream.update("https://example.com");
    await stream.flush();
    stream.update("https://example.com/final");
    await stream.flush();

    expect(rest.post).toHaveBeenCalledWith(Routes.channelMessages("c1"), {
      body: {
        content: "https://example.com",
        allowed_mentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
      },
    });
    expect(rest.patch).toHaveBeenCalledWith(Routes.channelMessage("c1", "m1"), {
      body: {
        content: "https://example.com/final",
        allowed_mentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
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
    expect(warn).toHaveBeenCalledWith("discord stream preview stopped (text length 6 > 5)");
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

  it("starts a new preview after a cleared turn is re-armed", async () => {
    const rest = {
      post: vi.fn().mockResolvedValueOnce({ id: "m1" }).mockResolvedValueOnce({ id: "m2" }),
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
    await stream.clear();
    stream.forceNewMessage();
    stream.update("queued turn draft");
    await stream.flush();

    expect(rest.post).toHaveBeenCalledTimes(2);
    expect(rest.delete).toHaveBeenCalledTimes(1);
    expect(stream.messageId()).toBe("m2");
  });

  it("preserves an in-flight block while starting the next block", async () => {
    let finishFirstCreate: ((value: { id: string }) => void) | undefined;
    const firstCreate = new Promise<{ id: string }>((resolve) => {
      finishFirstCreate = resolve;
    });
    const rest = {
      post: vi.fn().mockReturnValueOnce(firstCreate).mockResolvedValueOnce({ id: "m2" }),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const stream = createDiscordDraftStream({
      rest: rest as never,
      channelId: "c1",
      throttleMs: 250,
    });

    stream.update("old turn draft");
    await vi.waitFor(() => expect(rest.post).toHaveBeenCalledTimes(1));
    stream.forceNewMessage();
    stream.update("queued turn draft");
    finishFirstCreate?.({ id: "m1" });
    await stream.flush();

    expect(rest.post).toHaveBeenCalledTimes(2);
    expect(rest.post.mock.calls[1]?.[1]).toMatchObject({
      body: { content: "queued turn draft" },
    });
    expect(rest.delete).not.toHaveBeenCalled();
    expect(stream.messageId()).toBe("m2");
  });

  it("discards an in-flight progress draft while starting the queued turn", async () => {
    let finishFirstCreate: ((value: { id: string }) => void) | undefined;
    const firstCreate = new Promise<{ id: string }>((resolve) => {
      finishFirstCreate = resolve;
    });
    const rest = {
      post: vi.fn().mockReturnValueOnce(firstCreate).mockResolvedValueOnce({ id: "m2" }),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const stream = createDiscordDraftStream({
      rest: rest as never,
      channelId: "c1",
      throttleMs: 250,
    });

    stream.update("old progress draft");
    await vi.waitFor(() => expect(rest.post).toHaveBeenCalledTimes(1));
    stream.forceNewMessage("discard");
    stream.update("queued turn draft");
    finishFirstCreate?.({ id: "m1" });
    await stream.flush();

    expect(rest.post).toHaveBeenCalledTimes(2);
    expect(rest.post.mock.calls[1]?.[1]).toMatchObject({
      body: { content: "queued turn draft" },
    });
    expect(rest.delete).toHaveBeenCalledWith(Routes.channelMessage("c1", "m1"));
    expect(stream.messageId()).toBe("m2");
  });

  it("drops stale text restored by a failed in-flight send during rotation", async () => {
    let failFirstCreate: ((error: Error) => void) | undefined;
    const firstCreate = new Promise<{ id: string }>((_resolve, reject) => {
      failFirstCreate = reject;
    });
    const rest = {
      post: vi.fn().mockReturnValueOnce(firstCreate).mockResolvedValueOnce({ id: "m2" }),
      patch: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const stream = createDiscordDraftStream({
      rest: rest as never,
      channelId: "c1",
      throttleMs: 250,
    });

    stream.update("stale turn draft");
    await vi.waitFor(() => expect(rest.post).toHaveBeenCalledTimes(1));
    stream.forceNewMessage("discard");
    stream.update("queued turn draft");
    failFirstCreate?.(new Error("send failed"));
    await stream.flush();

    expect(rest.post).toHaveBeenCalledTimes(2);
    expect(rest.post.mock.calls[1]?.[1]).toMatchObject({
      body: { content: "queued turn draft" },
    });
    expect(stream.messageId()).toBe("m2");
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
