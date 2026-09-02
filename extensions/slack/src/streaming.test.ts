// Slack tests cover streaming plugin behavior.
import { WebClient } from "@slack/web-api";
import { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  appendSlackStream,
  markSlackStreamFallbackDelivered,
  markSlackStreamsStopped,
  SlackStreamNotDeliveredError,
  startSlackStream,
  stopSlackStream,
  type SlackStreamSession,
} from "./streaming.js";

type AppendImpl = () => Promise<unknown>;
type StopImpl = (args?: unknown) => Promise<unknown>;

function makeSession(params: { appendImpl?: AppendImpl; stopImpl?: StopImpl }): SlackStreamSession {
  return {
    streamer: {
      append: vi.fn(params.appendImpl ?? (async () => null)),
      stop: vi.fn(params.stopImpl ?? (async () => {})),
    } as unknown as ChatStreamer,
    channel: "C123",
    threadTs: "1700000000.000100",
    stopped: false,
    delivered: false,
    pendingText: "",
  };
}

function slackApiError(code: string): Error {
  const err = new Error(`An API error occurred: ${code}`);
  (err as unknown as { data: { error: string } }).data = { error: code };
  return err;
}

function createNativeStreamClient() {
  const client = new WebClient("xoxb-synthetic");
  const start = vi.spyOn(client.chat, "startStream").mockResolvedValue({
    ok: true,
    ts: "1700000000.500300",
  });
  const append = vi.spyOn(client.chat, "appendStream").mockResolvedValue({ ok: true });
  const stop = vi.spyOn(client.chat, "stopStream").mockResolvedValue({ ok: true });
  return { client, start, append, stop };
}

describe("stopSlackStream finalize error handling", () => {
  it("discards a Slack-stopped stream's buffered tail without flushing or falling back", async () => {
    const { client, append, stop } = createNativeStreamClient();
    const session = await startSlackStream({
      client,
      channel: "C123",
      threadTs: "1700000000.000100",
      text: "visible text",
      chunks: [],
    });
    await appendSlackStream({ session, text: "buffered tail" });
    markSlackStreamsStopped(new WebClient("xoxb-other"), "C123", ["1700000000.500300"]);
    expect(session.stopped).toBe(false);

    markSlackStreamsStopped(client, "C123", ["1700000000.500300"]);
    await appendSlackStream({ session, text: "late final", chunks: [] });
    markSlackStreamFallbackDelivered(session);
    await expect(stopSlackStream({ session })).resolves.toEqual({});

    expect(session).toMatchObject({
      stopped: true,
      stoppedBySlack: true,
      delivered: true,
      pendingText: "buffered tail",
    });
    expect(append).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("honors Stop received before the initial start response reveals the stream timestamp", async () => {
    const { client, start, stop } = createNativeStreamClient();
    const response = createDeferred<{ ok: boolean; ts: string }>();
    start.mockReturnValueOnce(response.promise);
    const starting = startSlackStream({
      client,
      channel: "C123",
      threadTs: "1700000000.000100",
      text: "initial text",
      chunks: [],
    });
    expect(start).toHaveBeenCalledOnce();
    markSlackStreamsStopped(client, "C123", ["1700000000.500300"]);
    response.resolve({ ok: true, ts: "1700000000.500300" });

    const session = await starting;
    await stopSlackStream({ session });

    expect(session.stoppedBySlack).toBe(true);
    expect(stop).not.toHaveBeenCalled();
  });

  it.each([
    { operation: "append", matches: true },
    { operation: "stop", matches: true },
    { operation: "append", matches: false },
    { operation: "stop", matches: false },
  ] as const)(
    "only suppresses in-flight $operation errors for a matching Stop event ($matches)",
    async ({ operation, matches }) => {
      const { client, append, stop } = createNativeStreamClient();
      const session = await startSlackStream({
        client,
        channel: "C123",
        threadTs: "1700000000.000100",
        text: "visible text",
        chunks: [],
      });
      const response = createDeferred<{ ok: boolean }>();
      const method = operation === "append" ? append : stop;
      method.mockReturnValueOnce(response.promise);
      const pending =
        operation === "append"
          ? appendSlackStream({ session, text: "pending tail", chunks: [] })
          : stopSlackStream({ session });
      expect(method).toHaveBeenCalledOnce();
      markSlackStreamsStopped(client, matches ? "C123" : "C_OTHER", ["1700000000.500300"]);
      const error = slackApiError("internal_error");
      response.reject(error);

      if (matches) {
        await pending;
        expect(session.stoppedBySlack).toBe(true);
        expect(session.pendingText).toBe(operation === "append" ? "pending tail" : "");
      } else {
        await expect(pending).rejects.toBe(error);
        expect(session.stoppedBySlack).toBeUndefined();
      }
    },
  );

  it("flushes short committed replies through the real SDK before stream finalization", async () => {
    const client = new WebClient("xoxb-synthetic");
    const start = vi.spyOn(client.chat, "startStream").mockResolvedValue({
      ok: true,
      ts: "1700000000.500300",
    });
    const append = vi.spyOn(client.chat, "appendStream").mockResolvedValue({ ok: true });
    vi.spyOn(client.chat, "stopStream").mockRejectedValue(slackApiError("internal_error"));

    const session = await startSlackStream({
      client,
      channel: "C123",
      threadTs: "1700000000.000100",
      text: "first short answer",
      chunks: [],
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_ts: "1700000000.000100",
        chunks: [{ type: "markdown_text", text: "first short answer" }],
      }),
    );

    await appendSlackStream({ session, text: "second short answer", chunks: [] });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        ts: "1700000000.500300",
        chunks: [{ type: "markdown_text", text: "second short answer" }],
      }),
    );
    expect(session.pendingText).toBe("");
    await expect(stopSlackStream({ session })).rejects.toThrow("internal_error");
    expect(session.delivered).toBe(true);
  });

  it("starts and appends supported structured stream chunks without buffering markdown text", async () => {
    const append = vi.fn(async () => ({ ts: "1700000000.100205" }));
    const client = {
      chatStream: vi.fn(() => ({
        append,
        stop: vi.fn(async () => {}),
      })),
    };
    const chunks = [{ type: "plan_update" as const, title: "Inspecting" }];

    const session = await startSlackStream({
      client: client as never,
      channel: "C123",
      threadTs: "1700000000.000100",
      chunks,
      taskDisplayMode: "plan",
      identity: { username: "Research Agent", iconEmoji: ":mag:" },
    });

    expect(client.chatStream).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "1700000000.000100",
      task_display_mode: "plan",
      username: "Research Agent",
      icon_emoji: ":mag:",
    });
    expect(append).toHaveBeenCalledWith({ chunks });
    expect(session.delivered).toBe(true);
    expect(session.pendingText).toBe("");
  });

  it("appends supported task update chunks to an active stream", async () => {
    const session = makeSession({
      appendImpl: async () => ({ ts: "1700000000.100206" }),
    });
    const chunks = [
      {
        type: "task_update" as const,
        id: "item_1",
        title: "Run tests",
        status: "in_progress" as const,
      },
    ];

    await appendSlackStream({ session, chunks });

    expect(session.streamer["append"]).toHaveBeenCalledWith({ chunks });
    expect(session.delivered).toBe(true);
    expect(session.pendingText).toBe("");
  });

  it("swallows user_not_found after prior append flushed (delivered=true)", async () => {
    const session = makeSession({
      appendImpl: async () => ({ ts: "1700000000.100200" }), // non-null => flushed
      stopImpl: async () => {
        throw slackApiError("user_not_found");
      },
    });
    await appendSlackStream({ session, text: "some text that Slack saw" });
    expect(session.delivered).toBe(true);

    await expect(stopSlackStream({ session })).resolves.toEqual({});
    expect(session.stopped).toBe(true);
  });

  it("falls back when deferred stream start rejects custom identity scope", async () => {
    const session = makeSession({
      stopImpl: async () => {
        throw slackApiError("missing_scope");
      },
    });
    session.pendingText = "short reply";

    const thrown = await stopSlackStream({ session }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(SlackStreamNotDeliveredError);
    expect(thrown).toMatchObject({ pendingText: "short reply", slackCode: "missing_scope" });
  });

  it("throws SlackStreamNotDeliveredError when user_not_found fires before any flush", async () => {
    const session = makeSession({
      appendImpl: async () => null, // null => buffered, never hit Slack
      stopImpl: async () => {
        throw slackApiError("user_not_found");
      },
    });
    await appendSlackStream({ session, text: "short reply under buffer size" });
    expect(session.delivered).toBe(false);

    const thrown = await stopSlackStream({ session }).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(SlackStreamNotDeliveredError);
    expect((thrown as SlackStreamNotDeliveredError).slackCode).toBe("user_not_found");
    expect((thrown as SlackStreamNotDeliveredError).pendingText).toBe(
      "short reply under buffer size",
    );
    expect(session.stopped).toBe(true);
  });

  it("throws SlackStreamNotDeliveredError for unexpected finalize codes while text is buffered", async () => {
    const session = makeSession({
      appendImpl: async () => null,
      stopImpl: async () => {
        throw slackApiError("method_not_supported_for_channel_type");
      },
    });
    await appendSlackStream({ session, text: "short thread reply" });

    const thrown = await stopSlackStream({ session }).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(SlackStreamNotDeliveredError);
    expect((thrown as SlackStreamNotDeliveredError).slackCode).toBe(
      "method_not_supported_for_channel_type",
    );
    expect((thrown as SlackStreamNotDeliveredError).pendingText).toBe("short thread reply");
  });

  it("does not retry ambiguous transport failures while text is buffered", async () => {
    const session = makeSession({
      appendImpl: async () => null,
      stopImpl: async () => {
        throw new Error("socket reset");
      },
    });
    await appendSlackStream({ session, text: "locally buffered reply" });

    await expect(stopSlackStream({ session })).rejects.toThrow("socket reset");
    expect(session.pendingText).toBe("locally buffered reply");
  });

  it("clears pendingText after an append flush is acknowledged by Slack", async () => {
    const session = makeSession({
      appendImpl: async () => ({ ts: "1700000000.100203" }),
    });

    await appendSlackStream({ session, text: "flushed text" });

    expect(session.delivered).toBe(true);
    expect(session.pendingText).toBe("");
  });

  it("passes message metadata when finalizing the stream", async () => {
    const stopImpl = vi.fn(async () => {});
    const session = makeSession({ stopImpl });
    const metadata = {
      event_type: "assistant_thread_context",
      event_payload: { channel_id: "C123", team_id: "T123" },
    };

    await stopSlackStream({ session, metadata });

    expect(stopImpl).toHaveBeenCalledWith({ metadata });
  });

  it("throws SlackStreamNotDeliveredError with buffered text when append flush fails", async () => {
    const session = makeSession({
      appendImpl: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(slackApiError("user_not_found")),
    });

    await appendSlackStream({ session, text: "first buffered" });
    const thrown = await appendSlackStream({ session, text: "\nsecond flushes" }).catch(
      (err: unknown) => err,
    );

    expect(thrown).toBeInstanceOf(SlackStreamNotDeliveredError);
    expect((thrown as SlackStreamNotDeliveredError).pendingText).toBe(
      "first buffered\nsecond flushes",
    );
  });

  it("falls back only still-pending tail text after a prior flush succeeded", async () => {
    const session = makeSession({
      appendImpl: vi
        .fn()
        .mockResolvedValueOnce({ ts: "1700000000.100204" })
        .mockResolvedValue(null),
      stopImpl: async () => {
        throw slackApiError("team_not_found");
      },
    });

    await appendSlackStream({ session, text: "already visible" });
    await appendSlackStream({ session, text: "\npending tail" });
    const thrown = await stopSlackStream({ session }).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(SlackStreamNotDeliveredError);
    expect((thrown as SlackStreamNotDeliveredError).pendingText).toBe("\npending tail");
  });

  it("swallows missing_recipient_user_id when delivered", async () => {
    const session = makeSession({
      appendImpl: async () => ({ ts: "1700000000.100201" }),
      stopImpl: async () => {
        throw slackApiError("missing_recipient_user_id");
      },
    });
    await appendSlackStream({ session, text: "chars" });
    await expect(stopSlackStream({ session })).resolves.toEqual({});
    expect(session.stopped).toBe(true);
  });

  it("re-throws unexpected Slack API errors even when delivered", async () => {
    const session = makeSession({
      appendImpl: async () => ({ ts: "1700000000.100202" }),
      stopImpl: async () => {
        throw slackApiError("not_authed");
      },
    });
    await appendSlackStream({ session, text: "some text" });
    await expect(stopSlackStream({ session })).rejects.toThrow(/not_authed/);
    // Session is still marked stopped so retries do not re-enter streamer.stop.
    expect(session.stopped).toBe(true);
  });

  it("re-throws non-Slack-shaped errors unchanged", async () => {
    const session = makeSession({
      stopImpl: async () => {
        throw new Error("socket reset");
      },
    });
    await expect(stopSlackStream({ session })).rejects.toThrow(/socket reset/);
    expect(session.stopped).toBe(true);
  });

  it("returns a no-op on an already-stopped session", async () => {
    const stop = vi.fn(async () => {});
    const session: SlackStreamSession = {
      streamer: { append: vi.fn(async () => null), stop } as unknown as ChatStreamer,
      channel: "C123",
      threadTs: "1700000000.000100",
      stopped: true,
      delivered: false,
      pendingText: "",
    };
    await expect(stopSlackStream({ session })).resolves.toEqual({});
    expect(stop).not.toHaveBeenCalled();
  });

  it("marks delivered=true on successful stop() without prior flush", async () => {
    const session = makeSession({
      appendImpl: async () => null,
      stopImpl: async () => {},
    });
    await appendSlackStream({ session, text: "short" });
    expect(session.delivered).toBe(false);
    await stopSlackStream({ session });
    expect(session.delivered).toBe(true);
    expect(session.pendingText).toBe("");
  });

  it("returns the finalized message ts as messageId on a successful stop()", async () => {
    const session = makeSession({
      appendImpl: async () => null,
      stopImpl: async () => ({ ok: true, ts: "1700000000.500100" }),
    });
    await appendSlackStream({ session, text: "short" });
    await expect(stopSlackStream({ session })).resolves.toEqual({
      messageId: "1700000000.500100",
    });
  });

  it("falls back to message.ts when chat.stopStream omits the top-level ts", async () => {
    const session = makeSession({
      appendImpl: async () => null,
      stopImpl: async () => ({ ok: true, message: { ts: "1700000000.500200" } }),
    });
    await appendSlackStream({ session, text: "short" });
    await expect(stopSlackStream({ session })).resolves.toEqual({
      messageId: "1700000000.500200",
    });
  });

  it("returns an empty result when chat.stopStream reports no ts", async () => {
    const session = makeSession({
      appendImpl: async () => null,
      stopImpl: async () => ({ ok: true }),
    });
    await appendSlackStream({ session, text: "short" });
    await expect(stopSlackStream({ session })).resolves.toEqual({});
  });

  it("converts a start-time flush rejection into a pending-text fallback error", async () => {
    const client = {
      chatStream: () => ({
        append: async () => {
          throw slackApiError("user_not_found");
        },
        stop: async () => {},
      }),
    };

    const thrown = await startSlackStream({
      client: client as never,
      channel: "C123",
      threadTs: "1700000000.000100",
      text: "initial chunk that flushes immediately",
    }).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(SlackStreamNotDeliveredError);
    expect((thrown as SlackStreamNotDeliveredError).pendingText).toBe(
      "initial chunk that flushes immediately",
    );
  });

  it("retires fallback-delivered sessions so buffered text cannot be resent", () => {
    const neverDelivered = makeSession({});
    markSlackStreamFallbackDelivered(neverDelivered);
    expect(neverDelivered.delivered).toBe(false);
    expect(neverDelivered.pendingText).toBe("");
    expect(neverDelivered.stopped).toBe(true);

    const alreadyDelivered = makeSession({});
    alreadyDelivered.delivered = true;
    markSlackStreamFallbackDelivered(alreadyDelivered);
    expect(alreadyDelivered.delivered).toBe(true);
    expect(alreadyDelivered.pendingText).toBe("");
    expect(alreadyDelivered.stopped).toBe(false);
  });

  it("does not resend committed text when finalization rejects after delivery", async () => {
    const streamTs = "1700000000.500300";
    const startStream = vi.fn(async () => ({ ok: true, ts: streamTs }));
    const stopStream = vi.fn().mockRejectedValue(slackApiError("user_not_found"));
    const client = {
      chat: {
        startStream,
        appendStream: vi.fn(async () => ({ ok: true })),
        stopStream,
      },
    };
    const streamer = new ChatStreamer(
      client as never,
      { debug: vi.fn() } as never,
      {
        channel: "C123",
        thread_ts: "1700000000.000100",
      },
      { buffer_size: 256 },
    );
    const session: SlackStreamSession = {
      streamer,
      channel: "C123",
      threadTs: "1700000000.000100",
      stopped: false,
      delivered: false,
      pendingText: "",
    };
    const metadata = { event_type: "openclaw.reply", event_payload: { turn: "qa" } };

    await appendSlackStream({ session, text: "short committed reply", chunks: [] });
    await expect(stopSlackStream({ session, metadata })).resolves.toEqual({});
    await expect(stopSlackStream({ session, metadata })).resolves.toEqual({});

    expect(startStream).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        chunks: [{ type: "markdown_text", text: "short committed reply" }],
      }),
    );
    expect(stopStream).toHaveBeenCalledExactlyOnceWith({
      token: undefined,
      channel: "C123",
      ts: streamTs,
      chunks: [],
      metadata,
    });
    expect(session.stopped).toBe(true);
    expect(session.delivered).toBe(true);
    expect(session.pendingText).toBe("");
  });

  it("clears the SDK buffer before finalizing an already-visible fallback stream", async () => {
    const startStream = vi.fn(async () => ({ ok: true, ts: "1700000000.500300" }));
    const stopStream = vi.fn(async () => ({ ok: true, ts: "1700000000.500300" }));
    const client = {
      chat: {
        startStream,
        appendStream: vi.fn(async () => ({ ok: true })),
        stopStream,
      },
    };
    const streamer = new ChatStreamer(
      client as never,
      { debug: vi.fn() } as never,
      {
        channel: "C123",
        thread_ts: "1700000000.000100",
      },
      { buffer_size: 10 },
    );
    const session: SlackStreamSession = {
      streamer,
      channel: "C123",
      threadTs: "1700000000.000100",
      stopped: false,
      delivered: false,
      pendingText: "",
    };

    await appendSlackStream({ session, text: "already visible" });
    await appendSlackStream({ session, text: "tail" });
    expect(session.delivered).toBe(true);
    expect(session.pendingText).toBe("tail");

    markSlackStreamFallbackDelivered(session);
    await stopSlackStream({ session });

    expect(startStream).toHaveBeenCalledOnce();
    expect(stopStream).toHaveBeenCalledWith({
      token: undefined,
      channel: "C123",
      ts: "1700000000.500300",
      chunks: [],
    });
  });
});
