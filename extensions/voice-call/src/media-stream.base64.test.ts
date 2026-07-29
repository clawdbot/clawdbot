import type { RealtimeTranscriptionSession } from "openclaw/plugin-sdk/realtime-transcription";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { MediaStreamHandler } from "./media-stream.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "./websocket-test-support.js";

describe("MediaStreamHandler base64 validation", () => {
  it("drops malformed media frames while keeping the stream usable", async () => {
    const sentAudio: Buffer[] = [];
    const session: RealtimeTranscriptionSession = {
      connect: async () => {},
      sendAudio: (audio) => sentAudio.push(Buffer.from(audio)),
      close: () => {},
      isConnected: () => true,
    };
    const handler = new MediaStreamHandler({
      transcriptionProvider: {
        createSession: () => session,
        id: "openai",
        label: "OpenAI",
        isConfigured: () => true,
      },
      providerConfig: {},
      shouldAcceptStream: () => true,
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
          streamSid: "MZ-base64",
          start: { callSid: "CA-base64" },
        }),
      );
      for (const payload of ["!!!not-valid-base64!!!", "   \t\n  "]) {
        ws.send(JSON.stringify({ event: "media", media: { payload } }));
      }
      ws.send(JSON.stringify({ event: "media", media: { payload: "-_8" } }));
      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: Buffer.from("valid").toString("base64") },
        }),
      );

      await vi.waitFor(() => {
        expect(sentAudio).toEqual([Buffer.from([0xfb, 0xff]), Buffer.from("valid")]);
      });
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
      await waitForClose(ws);
    } finally {
      await server.close();
    }
  });
});
