/** Tests reply payload sending through wired plugin hook flows. */
import { describe, expect, it, vi } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";
import type { PluginHookReplyPayload } from "./hook-types.js";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";

const replyPayloadSendingEvent = {
  payload: { text: "hello" } satisfies ReplyPayload,
  kind: "final" as const,
  channel: "telegram",
  sessionKey: "agent:test:session",
  runId: "run-123",
};

const replyPayloadSendingCtx = {
  channelId: "telegram",
  accountId: "default",
  conversationId: "conv-1",
  sessionKey: "agent:test:session",
  runId: "run-123",
};

function firstErrorLog(logger: { error: ReturnType<typeof vi.fn> }) {
  return logger.error.mock.calls[0];
}

describe("reply_payload_sending hook runner", () => {
  it("passes the latest payload between handlers", async () => {
    const first = vi.fn().mockResolvedValue({
      payload: {
        text: "hello",
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Proceed", value: "action:proceed" }] }],
        },
      } satisfies ReplyPayload,
    });
    const second = vi.fn().mockImplementation(async (event: { payload: ReplyPayload }) => ({
      payload: {
        ...event.payload,
        text: `${event.payload.text ?? ""}!`,
      },
    }));
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "reply_payload_sending", handler: first },
      { hookName: "reply_payload_sending", handler: second },
    ]);

    const result = await runner.runReplyPayloadSending(
      replyPayloadSendingEvent,
      replyPayloadSendingCtx,
    );

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(
      {
        ...replyPayloadSendingEvent,
        payload: {
          text: "hello",
          presentation: {
            blocks: [{ type: "buttons", buttons: [{ label: "Proceed", value: "action:proceed" }] }],
          },
        },
      },
      replyPayloadSendingCtx,
    );
    expect(result).toEqual({
      payload: {
        text: "hello!",
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Proceed", value: "action:proceed" }] }],
        },
      },
      cancel: undefined,
      reason: undefined,
    });
  });

  it("stops at the first handler that cancels delivery", async () => {
    const first = vi.fn().mockResolvedValue({ cancel: true, reason: "blocked" });
    const second = vi.fn();
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "reply_payload_sending", handler: first },
      { hookName: "reply_payload_sending", handler: second },
    ]);

    const result = await runner.runReplyPayloadSending(
      replyPayloadSendingEvent,
      replyPayloadSendingCtx,
    );

    expect(result).toEqual({
      payload: { text: "hello" },
      cancel: true,
      reason: "blocked",
    });
    expect(second).not.toHaveBeenCalled();
  });

  it("continues after handler errors", async () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const succeeding = vi
      .fn()
      .mockResolvedValue({ payload: { text: "ok" } satisfies ReplyPayload });
    const { runner } = createHookRunnerWithRegistry(
      [
        { hookName: "reply_payload_sending", handler: failing },
        { hookName: "reply_payload_sending", handler: succeeding },
      ],
      { logger },
    );

    const result = await runner.runReplyPayloadSending(
      replyPayloadSendingEvent,
      replyPayloadSendingCtx,
    );

    expect(result).toEqual({ payload: { text: "ok" }, cancel: undefined, reason: undefined });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(firstErrorLog(logger)).toEqual([
      "[hooks] reply_payload_sending handler from test-plugin failed: boom",
    ]);
  });

  it("does not expose trusted local media to plugins", async () => {
    const handler = vi
      .fn()
      .mockImplementation(async (event: { payload: PluginHookReplyPayload }) => {
        expect("trustedLocalMedia" in event.payload).toBe(false);
        return {
          payload: {
            ...event.payload,
            text: "plugin changed",
            trustedLocalMedia: true,
          } as ReplyPayload,
        };
      });
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "reply_payload_sending", handler },
    ]);

    const result = await runner.runReplyPayloadSending(
      {
        ...replyPayloadSendingEvent,
        payload: { text: "hello" } satisfies ReplyPayload,
      },
      replyPayloadSendingCtx,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect((result?.payload as ReplyPayload | undefined)?.trustedLocalMedia).toBeUndefined();
    expect(result?.payload).toMatchObject({ text: "plugin changed" });
  });

  it("preserves runtime-owned trusted local media across plugin edits", async () => {
    const handler = vi
      .fn()
      .mockImplementation(async (event: { payload: PluginHookReplyPayload }) => {
        expect("trustedLocalMedia" in event.payload).toBe(false);
        return { payload: { ...event.payload, text: "plugin changed" } };
      });
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "reply_payload_sending", handler },
    ]);

    const result = await runner.runReplyPayloadSending(
      {
        ...replyPayloadSendingEvent,
        payload: { text: "hello", trustedLocalMedia: true } as unknown as PluginHookReplyPayload,
      },
      replyPayloadSendingCtx,
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect((result?.payload as ReplyPayload | undefined)?.trustedLocalMedia).toBe(true);
    expect(result?.payload).toMatchObject({ text: "plugin changed" });
  });

  it("preserves internal reply metadata across plugin edits", async () => {
    const handler = vi
      .fn()
      .mockImplementation(async (event: { payload: PluginHookReplyPayload }) => ({
        payload: { ...event.payload, text: "plugin changed" },
      }));
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "reply_payload_sending", handler },
    ]);
    const payload = setReplyPayloadMetadata({ text: "hello" } satisfies ReplyPayload, {
      assistantMessageIndex: 7,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:test:session",
        text: "hello",
        idempotencyKey: "mirror-1",
      },
    });

    const result = await runner.runReplyPayloadSending(
      {
        ...replyPayloadSendingEvent,
        payload,
      },
      replyPayloadSendingCtx,
    );

    expect(result?.payload).toMatchObject({ text: "plugin changed" });
    expect(getReplyPayloadMetadata(result?.payload as ReplyPayload)).toEqual({
      assistantMessageIndex: 7,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:test:session",
        text: "hello",
        idempotencyKey: "mirror-1",
      },
    });
  });

  it("drops trusted local media when plugins change media refs", async () => {
    const handler = vi
      .fn()
      .mockImplementation(async (event: { payload: PluginHookReplyPayload }) => {
        expect("trustedLocalMedia" in event.payload).toBe(false);
        return {
          payload: {
            ...event.payload,
            mediaUrl: "file:///tmp/plugin-replaced.wav",
          },
        };
      });
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "reply_payload_sending", handler },
    ]);

    const result = await runner.runReplyPayloadSending(
      {
        ...replyPayloadSendingEvent,
        payload: {
          text: "hello",
          mediaUrl: "file:///tmp/runtime-owned.wav",
          trustedLocalMedia: true,
        } as unknown as PluginHookReplyPayload,
      },
      replyPayloadSendingCtx,
    );

    expect((result?.payload as ReplyPayload | undefined)?.trustedLocalMedia).toBeUndefined();
    expect(result?.payload).toMatchObject({
      text: "hello",
      mediaUrl: "file:///tmp/plugin-replaced.wav",
    });
  });
});
