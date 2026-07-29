import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chunkOpenAIQuicksilverAppendText,
  parseOpenAIQuicksilverEvent,
} from "./realtime-quicksilver-wire.js";
import {
  createRequest,
  createResponseHarness,
  parseSent,
  emitSideband,
  createBroker,
} from "./realtime-quicksilver.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("GPT-Live sideband protocol", () => {
  it("ignores session.updated server-side", () => {
    const type = "session.updated";
    expect(parseOpenAIQuicksilverEvent(JSON.stringify({ type }))).toEqual({
      kind: "ignored",
      eventType: type,
    });
  });

  it("parses direct WebSocket audio", () => {
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "output_audio.delta", audio: "AQIDBA==" }),
      ),
    ).toEqual({ kind: "audio", data: "AQIDBA==" });
  });

  it("parses session expiry and transcript events", () => {
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "session.started", session: { expires_at: 123 } }),
      ),
    ).toEqual({ kind: "session-started", expiresAt: 123 });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "input_transcript.added", item: { text: "hel" } }),
      ),
    ).toEqual({ kind: "transcript-delta", role: "user", text: "hel" });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "output_transcript.added", item: { text: "wor" } }),
      ),
    ).toEqual({ kind: "transcript-delta", role: "assistant", text: "wor" });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "turn.done", turn: { role: "user", transcript: "hello" } }),
      ),
    ).toEqual({ kind: "transcript-done", role: "user", text: "hello" });
  });

  it("parses client delegations and ignores non-client targets", () => {
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({
          type: "delegation.created",
          item: {
            type: "delegation",
            target: "client",
            id: "delegation-1",
            content: [
              { type: "input_text", text: "curl https://exa" },
              { type: "output_text", text: "ignored" },
              { type: "input_text", text: "mple.com" },
            ],
          },
        }),
      ),
    ).toEqual({ kind: "delegation", id: "delegation-1", prompt: "curl https://example.com" });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({
          type: "delegation.created",
          item: { type: "delegation", target: "server", id: "delegation-2", content: [] },
        }),
      ),
    ).toEqual({ kind: "ignored", eventType: "delegation.created" });
  });

  it("parses errors, reports unknown events, and rejects malformed JSON", () => {
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "error", error: { message: "call failed" } }),
      ),
    ).toEqual({ kind: "error", message: "call failed", fatalAuth: false });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({
          type: "error",
          message: "top-level failure",
          error: { message: "nested failure" },
        }),
      ),
    ).toEqual({ kind: "error", message: "top-level failure", fatalAuth: false });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "error", error: { code: "invalid_token" } }),
      ),
    ).toEqual({
      kind: "error",
      message: '{"code":"invalid_token"}',
      fatalAuth: true,
    });
    expect(parseOpenAIQuicksilverEvent(JSON.stringify({ type: "future.event" }))).toEqual({
      kind: "unknown",
      eventType: "future.event",
    });
    expect(parseOpenAIQuicksilverEvent("not-json")).toBeNull();
  });

  it("chunks appends by UTF-8 bytes without splitting characters", () => {
    const text = `${"a".repeat(499)}🙂${"b".repeat(501)}`;
    const chunks = chunkOpenAIQuicksilverAppendText(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(500);
    }
  });

  it("wraps delegated input and appends the raw speakable result", async () => {
    const runAgentConsult = vi.fn(async ({ prompt }: { prompt: string }) => ({
      text: `Result for ${prompt}`,
    }));
    const { realtime, sockets } = createBroker({ runAgentConsult });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-live-1",
          runAgentConsult,
        },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      const response = createResponseHarness();
      await realtime.handler(createRequest({ token: reservation.clientSecret }), response.res);
      const socket = sockets[0];
      if (!socket) {
        throw new Error("Expected sideband socket");
      }
      expect(socket.sent).toEqual([]);
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "delegation.created",
            item: {
              type: "delegation",
              target: "client",
              id: "delegation-1",
              content: [
                { type: "input_text", text: "first " },
                { type: "input_text", text: "task" },
              ],
            },
          }),
        ),
        false,
      );
      await vi.waitFor(() =>
        expect(runAgentConsult).toHaveBeenCalledWith({
          prompt: "<realtime_delegation>\n  <input>first task</input>\n</realtime_delegation>",
          signal: expect.any(AbortSignal),
        }),
      );
      await vi.waitFor(() =>
        expect(parseSent(socket)).toContainEqual({
          type: "delegation.context.append",
          delegation_item_id: "delegation-1",
          channel: "speakable",
          content: [
            {
              type: "input_text",
              text: "Result for <realtime_delegation>\n  <input>first task</input>\n</realtime_delegation>",
            },
          ],
        }),
      );
      await realtime.cleanup();
      expect(parseSent(socket).at(-1)).toEqual({ type: "session.close" });
      expect(socket.closed).toBe(true);
    } finally {
      await realtime.cleanup();
    }
  });

  it("adds the in-call transcript delta to each delegation and resets it", async () => {
    const runAgentConsult = vi.fn(async (_params: { prompt: string; signal?: AbortSignal }) => ({
      text: "Done",
    }));
    const { realtime, sockets } = createBroker({ runAgentConsult });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        { providerConfig: {}, model: "gpt-live-1-codex", runAgentConsult },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      await realtime.handler(
        createRequest({ token: reservation.clientSecret }),
        createResponseHarness().res,
      );
      const socket = sockets[0];
      if (!socket) {
        throw new Error("Expected sideband socket");
      }

      emitSideband(socket, { type: "input_transcript.added", item: { text: "hel" } });
      emitSideband(socket, {
        type: "turn.done",
        turn: { role: "user", transcript: "hello" },
      });
      emitSideband(socket, { type: "output_transcript.added", item: { text: "ack" } });
      emitSideband(socket, {
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "delegation-1",
          content: [{ type: "input_text", text: "check weather" }],
        },
      });
      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(1));
      expect(runAgentConsult.mock.calls[0]?.[0]?.prompt).toBe(
        "<realtime_delegation>\n  <input>check weather</input>\n  <transcript_delta>user: hello\nassistant: ack</transcript_delta>\n</realtime_delegation>",
      );

      emitSideband(socket, {
        type: "turn.done",
        turn: { role: "user", transcript: "second context" },
      });
      emitSideband(socket, {
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "delegation-2",
          content: [{ type: "input_text", text: "next task" }],
        },
      });
      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(2));
      expect(runAgentConsult.mock.calls[1]?.[0]?.prompt).toBe(
        "<realtime_delegation>\n  <input>next task</input>\n  <transcript_delta>user: second context</transcript_delta>\n</realtime_delegation>",
      );
    } finally {
      await realtime.cleanup();
    }
  });

  it("aborts the in-flight consult when a newer delegation arrives", async () => {
    const signals: AbortSignal[] = [];
    const resolutions: Array<(value: { text: string }) => void> = [];
    const runAgentConsult = vi.fn(
      ({ signal }: { prompt: string; signal?: AbortSignal }) =>
        new Promise<{ text: string }>((resolve) => {
          if (signal) {
            signals.push(signal);
          }
          resolutions.push(resolve);
        }),
    );
    const { realtime, sockets } = createBroker({ runAgentConsult });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        { providerConfig: {}, model: "gpt-live-1-codex", runAgentConsult },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      await realtime.handler(
        createRequest({ token: reservation.clientSecret }),
        createResponseHarness().res,
      );
      const socket = sockets[0];
      if (!socket) {
        throw new Error("Expected sideband socket");
      }

      for (const [id, text] of [
        ["delegation-1", "first"],
        ["delegation-2", "second"],
      ] as const) {
        emitSideband(socket, {
          type: "delegation.created",
          item: {
            type: "delegation",
            target: "client",
            id,
            content: [{ type: "input_text", text }],
          },
        });
        await vi.waitFor(() =>
          expect(runAgentConsult).toHaveBeenCalledTimes(id.endsWith("1") ? 1 : 2),
        );
      }

      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      resolutions[0]?.({ text: "stale" });
      resolutions[1]?.({ text: "fresh" });
      await vi.waitFor(() =>
        expect(parseSent(socket)).toContainEqual(
          expect.objectContaining({
            delegation_item_id: "delegation-2",
            channel: "speakable",
          }),
        ),
      );
      expect(parseSent(socket)).not.toContainEqual(
        expect.objectContaining({ delegation_item_id: "delegation-1" }),
      );
    } finally {
      await realtime.cleanup();
    }
  });

  it("skips empty delegations and keeps their transcript for the next one", async () => {
    const runAgentConsult = vi.fn(async (_params: { prompt: string; signal?: AbortSignal }) => ({
      text: "Done",
    }));
    const { realtime, sockets } = createBroker({ runAgentConsult });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        { providerConfig: {}, model: "gpt-live-1-codex", runAgentConsult },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      await realtime.handler(
        createRequest({ token: reservation.clientSecret }),
        createResponseHarness().res,
      );
      const socket = sockets[0];
      if (!socket) {
        throw new Error("Expected sideband socket");
      }
      emitSideband(socket, {
        type: "turn.done",
        turn: { role: "user", transcript: "hello" },
      });
      emitSideband(socket, {
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "empty",
          content: [{ type: "input_text", text: "  " }],
        },
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(runAgentConsult).not.toHaveBeenCalled();

      emitSideband(socket, {
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "delegation-1",
          content: [{ type: "input_text", text: "check weather" }],
        },
      });
      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(1));
      expect(runAgentConsult.mock.calls[0]?.[0]?.prompt).toBe(
        "<realtime_delegation>\n  <input>check weather</input>\n  <transcript_delta>user: hello</transcript_delta>\n</realtime_delegation>",
      );
    } finally {
      await realtime.cleanup();
    }
  });

  it("returns a speakable failure when the delegated agent fails", async () => {
    const runAgentConsult = vi.fn(async () => {
      throw new Error("workspace unavailable");
    });
    const { realtime, sockets, logger } = createBroker({ runAgentConsult });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        { providerConfig: {}, model: "gpt-live-1", runAgentConsult },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      await realtime.handler(
        createRequest({ token: reservation.clientSecret }),
        createResponseHarness().res,
      );
      const socket = sockets[0];
      if (!socket) {
        throw new Error("Expected sideband socket");
      }
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "delegation.created",
            item: {
              type: "delegation",
              target: "client",
              id: "delegation-failed",
              content: [{ type: "input_text", text: "do work" }],
            },
          }),
        ),
        false,
      );
      await vi.waitFor(() => {
        expect(parseSent(socket)).toContainEqual(
          expect.objectContaining({
            type: "delegation.context.append",
            delegation_item_id: "delegation-failed",
            channel: "speakable",
            content: [
              {
                type: "input_text",
                text: "The agent task failed. Tell the user it did not complete and offer to try again.",
              },
            ],
          }),
        );
      });
      // The raw failure detail must stay in Gateway logs, never on the provider sideband.
      expect(JSON.stringify(parseSent(socket))).not.toContain("workspace unavailable");
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("workspace unavailable"));
    } finally {
      await realtime.cleanup();
    }
  });
});
