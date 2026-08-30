import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createRealtimeTranscriptionWebSocketSession } from "./websocket-session.js";

let session: ReturnType<typeof createRealtimeTranscriptionWebSocketSession> | undefined;
let server: WebSocketServer | undefined;

afterEach(async () => {
  session?.close();
  session = undefined;
  const activeServer = server;
  if (activeServer) {
    await new Promise<void>((resolve) => {
      activeServer.close(() => resolve());
    });
  }
  server = undefined;
});

describe("createRealtimeTranscriptionWebSocketSession protocols", () => {
  it("negotiates configured WebSocket subprotocols", async () => {
    const seenProtocols: string[][] = [];
    server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      handleProtocols: (protocols) => {
        seenProtocols.push([...protocols]);
        return protocols.has("binary") ? "binary" : false;
      },
    });
    await new Promise<void>((resolve) => {
      server?.once("listening", resolve);
    });
    const port = (server.address() as AddressInfo).port;

    session = createRealtimeTranscriptionWebSocketSession({
      providerId: "test",
      callbacks: {},
      url: `ws://127.0.0.1:${port}`,
      protocols: ["binary"],
      readyOnOpen: true,
      sendAudio: (audio, transport) => {
        transport.sendBinary(audio);
      },
    });

    await session.connect();

    expect(seenProtocols).toEqual([["binary"]]);
    const socket = Reflect.get(session, "ws") as WebSocket;
    expect(socket.protocol).toBe("binary");
  });
});
