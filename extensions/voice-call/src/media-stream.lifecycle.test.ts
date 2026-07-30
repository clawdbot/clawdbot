import type { RealtimeTranscriptionSession } from "openclaw/plugin-sdk/realtime-transcription";
import { describe, expect, it, vi } from "vitest";
import { MediaStreamHandler } from "./media-stream.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "./websocket-test-support.js";

describe("MediaStreamHandler lifecycle", () => {
  it("rejects duplicate start frames without creating another STT session", async () => {
    const closeSession = vi.fn();
    const sttSession: RealtimeTranscriptionSession = {
      connect: async () => {},
      sendAudio: () => {},
      close: closeSession,
      isConnected: () => true,
    };
    const createSession = vi.fn(() => sttSession);
    const shouldAcceptStream = vi.fn(() => true);
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const handler = new MediaStreamHandler({
      transcriptionProvider: {
        createSession,
        id: "openai",
        label: "OpenAI",
        isConfigured: () => true,
      },
      providerConfig: {},
      shouldAcceptStream,
      onConnect,
      onDisconnect,
    });
    const server = await startUpgradeWsServer({
      urlPath: "/voice/stream",
      onUpgrade: (request, socket, head) => {
        handler.handleUpgrade(request, socket, head);
      },
    });

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-first",
          start: { callSid: "CA-first" },
        }),
      );
      await vi.waitFor(() => {
        expect(onConnect).toHaveBeenCalledWith("CA-first", "MZ-first");
      });

      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-second",
          start: { callSid: "CA-second" },
        }),
      );
      const closed = await waitForClose(ws);

      expect(closed).toEqual({ code: 1008, reason: "Duplicate start" });
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(shouldAcceptStream).toHaveBeenCalledTimes(1);
      expect(onConnect).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(closeSession).toHaveBeenCalledTimes(1);
        expect(onDisconnect).toHaveBeenCalledWith("CA-first", "MZ-first");
        expect(onDisconnect).toHaveBeenCalledTimes(1);
      });
    } finally {
      await server.close();
    }
  });

  it("terminates active streams and shares concurrent close completion", async () => {
    const closeSession = vi.fn();
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const handler = new MediaStreamHandler({
      transcriptionProvider: {
        createSession: () => ({
          connect: async () => {},
          sendAudio: () => {},
          close: closeSession,
          isConnected: () => true,
        }),
        id: "openai",
        label: "OpenAI",
        isConfigured: () => true,
      },
      providerConfig: {},
      shouldAcceptStream: () => true,
      onConnect,
      onDisconnect,
    });
    const server = await startUpgradeWsServer({
      urlPath: "/voice/stream",
      onUpgrade: (request, socket, head) => {
        handler.handleUpgrade(request, socket, head);
      },
    });
    const ws = await connectWs(server.url);

    try {
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-shutdown",
          start: { callSid: "CA-shutdown" },
        }),
      );
      await vi.waitFor(() => {
        expect(onConnect).toHaveBeenCalledWith("CA-shutdown", "MZ-shutdown");
      });

      const closed = waitForClose(ws);
      const firstClose = handler.close();
      const secondClose = handler.close();

      expect(secondClose).toBe(firstClose);
      await firstClose;
      expect(await closed).toEqual({ code: 1006, reason: "" });
      expect(closeSession).toHaveBeenCalledTimes(1);
      expect(onDisconnect).toHaveBeenCalledWith("CA-shutdown", "MZ-shutdown");
      expect(onDisconnect).toHaveBeenCalledTimes(1);
    } finally {
      ws.terminate();
      await handler.close();
      await server.close();
    }
  });
});
