// Slack tests cover streaming plugin behavior.
import { WebClient } from "@slack/web-api";
import { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { getSlackListenerWriteClient } from "./client.js";
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
  const writeClient = getSlackListenerWriteClient({ listenerClient: client });
  if (!writeClient) {
    throw new Error("missing synthetic stream writer");
  }
  const start = vi.spyOn(writeClient.chat, "startStream").mockResolvedValue({
    ok: true,
    ts: "1700000000.500300",
  });
  const append = vi.spyOn(writeClient.chat, "appendStream").mockResolvedValue({ ok: true });
  const stop = vi.spyOn(writeClient.chat, "stopStream").mockResolvedValue({ ok: true });
  const update = vi.spyOn(writeClient.chat, "update").mockResolvedValue({ ok: true });
  return { client, start, append, stop, update };
}

describe("stopSlackStream finalize error handling", () => {
  it("recovers an expired stream on the same message and preserves subsequent final text and metadata", async () => {
    const { client, start, append, stop, update } = createNativeStreamClient();
    const session = await startSlackStream({
      client,
      channel: "C123",
      threadTs: "1700000000.000100",
      text: "Visible prefix",
      taskDisplayMode: "plan",
      chunks: [
        { type: "plan_update", title: "Inspect" },
        {
          type: "task_update",
          id: "task-1",
          title: "Read source",
          status: "in_progress",
          details: "Full details",
          output: "Initial output",
          sources: [{ type: "url", url: "https://example.com/source", text: "Source" }],
        },
      ],
    });
    append.mockRejectedValueOnce(slackApiError("message_not_in_streaming_state"));
    await appendSlackStream({
      session,
      text: " recovered tail",
      chunks: [
        {
          type: "task_update",
          id: "task-1",
          title: "Read source",
          status: "complete",
          details: " appended details",
          output: " appended output",
        },
      ],
    });
    await appendSlackStream({ session, text: " final answer", chunks: [] });
    const metadata = {
      event_type: "assistant_thread_context",
      event_payload: { channel_id: "C123" },
    };
    await expect(
      stopSlackStream({ session, chunks: [{ type: "plan_update", title: "Done" }], metadata }),
    ).resolves.toEqual({ messageId: "1700000000.500300" });
    expect(start).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(3);
    expect(
      update.mock.calls.every(
        ([args]) => args.channel === "C123" && args.ts === "1700000000.500300",
      ),
    ).toBe(true);
    expect(update.mock.lastCall?.[0]).toMatchObject({
      metadata,
      blocks: [
        { type: "markdown", text: "Visible prefix" },
        {
          type: "plan",
          title: "Done",
          tasks: [
            {
              task_id: "task-1",
              title: "Read source",
              status: "complete",
              details: {
                type: "rich_text",
                elements: [
                  {
                    type: "rich_text_section",
                    elements: [{ type: "text", text: "Full details appended details" }],
                  },
                ],
              },
              output: {
                type: "rich_text",
                elements: [
                  {
                    type: "rich_text_section",
                    elements: [{ type: "text", text: "Initial output appended output" }],
                  },
                ],
              },
              sources: [{ type: "url", url: "https://example.com/source", text: "Source" }],
            },
          ],
        },
        { type: "markdown", text: " recovered tail final answer" },
      ],
    });
    expect(session).toMatchObject({ stopped: true, delivered: true, pendingText: "" });
  });

  it("recovers stop-time expiry with final chunks and buffered text", async () => {
    const { client, stop, update } = createNativeStreamClient();
    const session = await startSlackStream({
      client,
      channel: "C123",
      threadTs: "1700000000.000100",
      text: "prefix",
      chunks: [],
    });
    await appendSlackStream({ session, text: " buffered final" });
    stop.mockRejectedValueOnce(slackApiError("message_not_in_streaming_state"));
    const metadata = { event_type: "openclaw.reply", event_payload: { turn: "qa" } };
    await expect(
      stopSlackStream({
        session,
        chunks: [{ type: "markdown_text", text: " final chunk" }],
        metadata,
      }),
    ).resolves.toEqual({ messageId: "1700000000.500300" });
    expect(update).toHaveBeenCalledExactlyOnceWith({
      channel: "C123",
      ts: "1700000000.500300",
      blocks: [{ type: "markdown", text: "prefix buffered final final chunk" }],
      metadata,
    });
    await stopSlackStream({ session });
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(["before-recovery", "after-recovery"])(
    "honors Slack Stop %s without another update or final delivery",
    async (phase) => {
      const { client, append, stop, update } = createNativeStreamClient();
      const session = await startSlackStream({
        client,
        channel: "C123",
        threadTs: "1700000000.000100",
        text: "prefix",
        chunks: [],
      });
      if (phase === "before-recovery") {
        const response = createDeferred<{ ok: boolean }>();
        append.mockReturnValueOnce(response.promise);
        const pending = appendSlackStream({ session, text: " tail", chunks: [] });
        markSlackStreamsStopped(client, "C123", ["1700000000.500300"]);
        response.reject(slackApiError("message_not_in_streaming_state"));
        await pending;
      } else {
        append.mockRejectedValueOnce(slackApiError("message_not_in_streaming_state"));
        await appendSlackStream({ session, text: " tail", chunks: [] });
        markSlackStreamsStopped(client, "C123", ["1700000000.500300"]);
      }
      await appendSlackStream({ session, text: "late final", chunks: [] });
      await stopSlackStream({ session });
      expect(update).toHaveBeenCalledTimes(phase === "before-recovery" ? 0 : 1);
      expect(stop).not.toHaveBeenCalled();
      expect(session.stoppedBySlack).toBe(true);
    },
  );

  it.each([
    new Error("socket reset"),
    slackApiError("internal_error"),
    slackApiError("fatal_error"),
  ])("does not replay failed recovery updates: %s", async (error) => {
    const { client, append, stop, update } = createNativeStreamClient();
    const session = await startSlackStream({
      client,
      channel: "C123",
      threadTs: "1700000000.000100",
      text: "prefix",
      chunks: [],
    });
    append.mockRejectedValueOnce(slackApiError("message_not_in_streaming_state"));
    update.mockRejectedValueOnce(error);
    await expect(appendSlackStream({ session, text: " tail", chunks: [] })).rejects.toBe(error);
    await appendSlackStream({ session, text: "late final", chunks: [] });
    await stopSlackStream({ session });
    expect(update).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(session.pendingText).toBe(" tail");
  });

  it("keeps ordinary tail fallback for definitive expiry without a known message timestamp", async () => {
    const { client, start, update } = createNativeStreamClient();
    const error = slackApiError("message_not_in_streaming_state");
    start.mockRejectedValueOnce(error);
    await expect(
      startSlackStream({
        client,
        channel: "C123",
        threadTs: "1700000000.000100",
        text: "prefix",
        chunks: [],
      }),
    ).rejects.toMatchObject({
      name: "SlackStreamNotDeliveredError",
      pendingText: "prefix",
      slackCode: "message_not_in_streaming_state",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("preserves all 51 tasks and an old task's late failure across multiple Plan blocks", async () => {
    const { client, append, update } = createNativeStreamClient();
    const session = await startSlackStream({
      client,
      channel: "C123",
      threadTs: "1700000000.000100",
      taskDisplayMode: "plan",
      chunks: Array.from({ length: 51 }, (_, i) => ({
        type: "task_update",
        id: `task-${i}`,
        title: `Task ${i}`,
        status: "complete",
      })),
    });
    append.mockRejectedValueOnce(slackApiError("message_not_in_streaming_state"));
    await appendSlackStream({
      session,
      chunks: [{ type: "task_update", id: "task-0", title: "Task 0", status: "error" }],
    });
    const args = update.mock.lastCall?.[0];
    const blocks = args && "blocks" in args ? args.blocks : undefined;
    expect(blocks).toEqual([
      {
        type: "plan",
        title: "",
        tasks: Array.from({ length: 50 }, (_, i) => ({
          task_id: `task-${i}`,
          title: `Task ${i}`,
          status: i === 0 ? "error" : "complete",
        })),
      },
      {
        type: "plan",
        title: "",
        tasks: [{ task_id: "task-50", title: "Task 50", status: "complete" }],
      },
    ]);
    await stopSlackStream({ session });
  });

  it("keeps timeline task positions relative to interleaved narration", async () => {
    const { client, append, update } = createNativeStreamClient();
    const session = await startSlackStream({
      client,
      channel: "C123",
      threadTs: "1700000000.000100",
      taskDisplayMode: "timeline",
      chunks: [{ type: "task_update", id: "one", title: "One", status: "in_progress" }],
    });
    await appendSlackStream({
      session,
      text: "Between tasks",
      chunks: [{ type: "task_update", id: "two", title: "Two", status: "pending" }],
    });
    append.mockRejectedValueOnce(slackApiError("message_not_in_streaming_state"));
    await appendSlackStream({
      session,
      chunks: [{ type: "task_update", id: "one", title: "One", status: "complete" }],
    });
    const args = update.mock.lastCall?.[0];
    const blocks = args && "blocks" in args ? args.blocks : undefined;
    expect(blocks).toEqual([
      { type: "task_card", task_id: "one", title: "One", status: "complete" },
      { type: "markdown", text: "Between tasks" },
      { type: "task_card", task_id: "two", title: "Two", status: "pending" },
    ]);
    await stopSlackStream({ session });
  });

  it.each(["markdown", "blocks"])(
    "refuses a truncated recovery exceeding Slack %s limits",
    async (limit) => {
      const { client, append, update, stop } = createNativeStreamClient();
      const session = await startSlackStream({
        client,
        channel: "C123",
        threadTs: "1700000000.000100",
        text: limit === "markdown" ? "x".repeat(12001) : "prefix",
        chunks:
          limit === "blocks"
            ? [{ type: "blocks", blocks: Array.from({ length: 50 }, () => ({ type: "divider" })) }]
            : [],
      });
      append.mockRejectedValueOnce(slackApiError("message_not_in_streaming_state"));
      await expect(appendSlackStream({ session, text: " tail", chunks: [] })).rejects.toMatchObject(
        { name: "SlackStreamNotDeliveredError", pendingText: " tail" },
      );
      expect(update).not.toHaveBeenCalled();
      await stopSlackStream({ session });
      expect(stop).not.toHaveBeenCalled();
    },
  );

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
    const { client, start, append, stop } = createNativeStreamClient();
    stop.mockRejectedValue(slackApiError("internal_error"));

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
    const { client, start } = createNativeStreamClient();
    const chunks = [{ type: "plan_update" as const, title: "Inspecting" }];

    const session = await startSlackStream({
      client,
      channel: "C123",
      threadTs: "1700000000.000100",
      chunks,
      taskDisplayMode: "plan",
      identity: { username: "Research Agent", iconEmoji: ":mag:" },
    });

    expect(start).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "1700000000.000100",
      task_display_mode: "plan",
      username: "Research Agent",
      icon_emoji: ":mag:",
      token: undefined,
      chunks,
    });
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

  it.each([
    new Error("socket reset"),
    slackApiError("internal_error"),
    slackApiError("fatal_error"),
  ])("does not replay an ambiguous append through later append or stop: %s", async (error) => {
    const { client, append, stop } = createNativeStreamClient();
    const session = await startSlackStream({
      client,
      channel: "C123",
      threadTs: "1700000000.000100",
      text: "acknowledged prefix",
      chunks: [],
    });
    await appendSlackStream({ session, text: "buffered suffix" });
    append.mockRejectedValueOnce(error);

    await expect(appendSlackStream({ session, text: " final suffix", chunks: [] })).rejects.toBe(
      error,
    );
    await appendSlackStream({ session, text: "late final", chunks: [] });
    await stopSlackStream({ session });

    expect(append).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        chunks: [{ type: "markdown_text", text: "buffered suffix final suffix" }],
      }),
    );
    expect(stop).not.toHaveBeenCalled();
    expect(session.pendingText).toBe("buffered suffix final suffix");
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

  it.each(["user_not_found", "missing_scope"])(
    "preserves pending text when append rejects with %s",
    async (code) => {
      const session = makeSession({
        appendImpl: vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(slackApiError(code)),
      });

      await appendSlackStream({ session, text: "first buffered" });
      const thrown = await appendSlackStream({ session, text: "\nsecond flushes" }).catch(
        (err: unknown) => err,
      );

      expect(thrown).toBeInstanceOf(SlackStreamNotDeliveredError);
      expect((thrown as SlackStreamNotDeliveredError).pendingText).toBe(
        "first buffered\nsecond flushes",
      );
    },
  );

  it.each(["team_not_found"])(
    "preserves only the rejected tail and tolerates finalize after %s fallback",
    async (code) => {
      const { client, append, stop } = createNativeStreamClient();
      const session = await startSlackStream({
        client,
        channel: "C123",
        threadTs: "1700000000.000100",
        text: "already visible",
        chunks: [],
      });
      append.mockRejectedValue(slackApiError(code));
      stop.mockRejectedValue(slackApiError(code));

      await expect(
        appendSlackStream({ session, text: "pending tail", chunks: [] }),
      ).rejects.toMatchObject({
        name: "SlackStreamNotDeliveredError",
        pendingText: "pending tail",
      });
      await expect(stopSlackStream({ session })).rejects.toMatchObject({
        name: "SlackStreamNotDeliveredError",
        pendingText: "pending tail",
      });
      markSlackStreamFallbackDelivered(session);
      await expect(stopSlackStream({ session })).resolves.toEqual({});
      await expect(stopSlackStream({ session })).resolves.toEqual({});
      expect(stop).toHaveBeenCalledTimes(2);
      expect(stop.mock.calls[1]?.[0]).not.toHaveProperty("markdown_text");
      expect(session).toMatchObject({ stopped: true, delivered: true, pendingText: "" });
    },
  );

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

  it.each([
    "user_not_found",
    "missing_scope",
    "channel_type_not_supported",
    "missing_recipient_team_id",
    "enterprise_is_restricted",
  ])("preserves pending text when start rejects with %s", async (code) => {
    const { client, start } = createNativeStreamClient();
    start.mockRejectedValueOnce(slackApiError(code));

    const thrown = await startSlackStream({
      client,
      channel: "C123",
      threadTs: "1700000000.000100",
      text: "initial chunk that flushes immediately",
      chunks: [],
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
