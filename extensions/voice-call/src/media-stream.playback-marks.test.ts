// Voice Call tests cover Twilio playback-mark acknowledgement behavior.
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
} from "openclaw/plugin-sdk/realtime-transcription";
import type { TalkEvent } from "openclaw/plugin-sdk/realtime-voice";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { MediaStreamHandler } from "./media-stream.js";
import {
  connectWs,
  startUpgradeWsServer,
  waitForClose,
  withTimeout,
} from "./websocket-test-support.js";

const createStubSession = (): RealtimeTranscriptionSession => ({
  connect: async () => {},
  sendAudio: () => {},
  close: () => {},
  isConnected: () => true,
});

const createStubSttProvider = (): RealtimeTranscriptionProviderPlugin =>
  ({
    createSession: () => createStubSession(),
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
  }) as unknown as RealtimeTranscriptionProviderPlugin;

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
};

const nextWsMessage = (ws: WebSocket): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(requireRecord(JSON.parse(rawDataToString(data)), "WebSocket message"));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

const startWsServer = async (
  handler: MediaStreamHandler,
): Promise<{
  url: string;
  close: () => Promise<void>;
}> =>
  startUpgradeWsServer({
    urlPath: "/voice/stream",
    onUpgrade: (request, socket, head) => {
      handler.handleUpgrade(request, socket, head);
    },
  });

describe("MediaStreamHandler playback marks", () => {
  it("completes queued playback only after Twilio echoes its mark", async () => {
    const onConnect = vi.fn();
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      shouldAcceptStream: () => true,
      onConnect,
    });
    const server = await startWsServer(handler);
    let ws: WebSocket | undefined;

    try {
      ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-mark",
          start: { callSid: "CA-mark" },
        }),
      );
      await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce());

      const outboundMark = nextWsMessage(ws);
      let completed = false;
      const playback = handler
        .queueTts("MZ-mark", async (signal) => {
          await handler.sendMarkAndWait("MZ-mark", "tts-complete", 100, signal);
        })
        .then(() => {
          completed = true;
        });
      expect(await withTimeout(outboundMark)).toMatchObject({
        event: "mark",
        mark: { name: "tts-complete" },
      });
      await Promise.resolve();
      expect(completed).toBe(false);

      ws.send(
        JSON.stringify({
          event: "mark",
          streamSid: "MZ-mark",
          mark: { name: "tts-complete" },
        }),
      );
      await withTimeout(playback);
      expect(completed).toBe(true);

      ws.close();
      await waitForClose(ws);
    } finally {
      ws?.terminate();
      await server.close();
    }
  });

  it("reports whether the carrier acknowledged the mark or the wait timed out", async () => {
    const onConnect = vi.fn();
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      shouldAcceptStream: () => true,
      onConnect,
    });
    const server = await startWsServer(handler);
    let ws: WebSocket | undefined;

    try {
      ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-ack",
          start: { callSid: "CA-ack" },
        }),
      );
      await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce());

      const acknowledgedMark = nextWsMessage(ws);
      let acknowledged: boolean | undefined;
      const playback = handler.queueTts("MZ-ack", async (signal) => {
        acknowledged = await handler.sendMarkAndWait("MZ-ack", "tts-acked", 100, signal);
      });
      await withTimeout(acknowledgedMark);
      ws.send(
        JSON.stringify({
          event: "mark",
          streamSid: "MZ-ack",
          mark: { name: "tts-acked" },
        }),
      );
      await withTimeout(playback);
      expect(acknowledged).toBe(true);

      // Never echoed back: the local timeout resolves the wait as unconfirmed.
      const timedOutMark = nextWsMessage(ws);
      let timedOut: boolean | undefined;
      const stalled = handler.queueTts("MZ-ack", async (signal) => {
        timedOut = await handler.sendMarkAndWait("MZ-ack", "tts-timeout", 1, signal);
      });
      await withTimeout(timedOutMark);
      // Waits out PLAYBACK_MARK_TIMEOUT_GRACE_MS (2s) with no echo from the carrier.
      await withTimeout(stalled, 6_000);
      expect(timedOut).toBe(false);

      ws.close();
      await waitForClose(ws);
    } finally {
      ws?.terminate();
      await server.close();
    }
  });

  it("ignores a playback mark echoed after clear", async () => {
    const onConnect = vi.fn();
    const talkEvents: TalkEvent[] = [];
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      shouldAcceptStream: () => true,
      onConnect,
      onTalkEvent: (_callId, _streamSid, event) => talkEvents.push(event),
    });
    const server = await startWsServer(handler);
    let ws: WebSocket | undefined;

    try {
      ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-clear-mark",
          start: { callSid: "CA-clear-mark" },
        }),
      );
      await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce());

      const outboundMark = nextWsMessage(ws);
      const playback = handler.queueTts("MZ-clear-mark", async (signal) => {
        await handler.sendMarkAndWait("MZ-clear-mark", "tts-cleared", 100, signal);
      });
      await withTimeout(outboundMark);
      handler.clearTtsQueue("MZ-clear-mark", "barge-in");
      await withTimeout(playback);
      expect(talkEvents.some((event) => event.type === "output.audio.done")).toBe(false);

      const state = handler as unknown as {
        ignoredPlaybackMarks: Map<string, Set<string>>;
      };
      expect(state.ignoredPlaybackMarks.get("MZ-clear-mark")).toContain("tts-cleared");
      ws.send(
        JSON.stringify({
          event: "mark",
          streamSid: "MZ-clear-mark",
          mark: { name: "tts-cleared" },
        }),
      );
      await vi.waitFor(() => {
        expect(state.ignoredPlaybackMarks.get("MZ-clear-mark")?.has("tts-cleared") ?? false).toBe(
          false,
        );
      });
      expect(talkEvents.some((event) => event.type === "output.audio.done")).toBe(false);

      ws.close();
      await waitForClose(ws);
    } finally {
      ws?.terminate();
      await server.close();
    }
  });
});
