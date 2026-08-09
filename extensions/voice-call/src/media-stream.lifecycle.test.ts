import type { RealtimeTranscriptionSession } from "openclaw/plugin-sdk/realtime-transcription";
import { describe, expect, it, vi } from "vitest";
import { MediaStreamHandler } from "./media-stream.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "./websocket-test-support.js";

describe("MediaStreamHandler lifecycle", () => {
  it("keeps rejecting upgrades through the shutdown barrier without active sockets", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: {
        createSession: () => ({
          connect: async () => {},
          sendAudio: () => {},
          close: () => {},
          isConnected: () => true,
        }),
        id: "openai",
        label: "OpenAI",
        isConfigured: () => true,
      },
      providerConfig: {},
    });
    let releaseShutdownBarrier: (() => void) | undefined;
    const shutdownBarrier = new Promise<void>((resolve) => {
      releaseShutdownBarrier = resolve;
    });
    const close = handler.close(shutdownBarrier);
    let closeSettled = false;
    void close.then(() => {
      closeSettled = true;
    });

    await Promise.resolve();
    expect(closeSettled).toBe(false);

    releaseShutdownBarrier?.();
    await close;
    expect(closeSettled).toBe(true);
  });

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
    let releaseShutdownBarrier: (() => void) | undefined;

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
      const shutdownBarrier = new Promise<void>((resolve) => {
        releaseShutdownBarrier = resolve;
      });
      const firstClose = handler.close(shutdownBarrier);
      const secondClose = handler.close();
      let closeSettled = false;
      void firstClose.then(() => {
        closeSettled = true;
      });

      expect(secondClose).toBe(firstClose);
      expect(await closed).toEqual({ code: 1006, reason: "" });
      await vi.waitFor(() => {
        expect(closeSession).toHaveBeenCalledTimes(1);
        expect(onDisconnect).toHaveBeenCalledWith("CA-shutdown", "MZ-shutdown");
        expect(onDisconnect).toHaveBeenCalledTimes(1);
      });
      expect(closeSettled).toBe(false);

      releaseShutdownBarrier?.();
      await firstClose;
      expect(closeSettled).toBe(true);
    } finally {
      releaseShutdownBarrier?.();
      ws.terminate();
      await handler.close();
      await server.close();
    }
  });
});
