import http, { type IncomingMessage, type Server } from "node:http";
import net, { type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { NormalizedEvent } from "../types.js";
import type { RealtimeTelephonyStream } from "../webhook/realtime-handler.js";

const { guardedJsonApiRequestMock } = vi.hoisted(() => ({
  guardedJsonApiRequestMock: vi.fn(),
}));

vi.mock("./shared/guarded-json-api.js", () => ({
  guardedJsonApiRequest: guardedJsonApiRequestMock,
}));

import { AsteriskProvider, type AsteriskRealtimeHandler } from "./asterisk.js";

const servers: Server[] = [];
const sockets: Socket[] = [];

function encodeAudioSocketUuid(uuid: string): Buffer {
  const payload = Buffer.from(uuid.replaceAll("-", ""), "hex");
  const frame = Buffer.alloc(3 + payload.length);
  frame[0] = 0x01;
  frame.writeUInt16BE(payload.length, 1);
  payload.copy(frame, 3);
  return frame;
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP port");
  }
  const port = address.port;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
}

async function startAriEventServer(): Promise<{
  baseUrl: string;
  authorization: Promise<string | undefined>;
  sendEvent(event: object): void;
}> {
  let eventSocket: WebSocket | undefined;
  let resolveAuthorization: (value: string | undefined) => void = () => {};
  const authorization = new Promise<string | undefined>((resolve) => {
    resolveAuthorization = resolve;
  });
  const server = http.createServer((_request, response) => {
    response.writeHead(404).end();
  });
  servers.push(server);
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    resolveAuthorization(request.headers.authorization);
    wss.handleUpgrade(request, socket, head, (ws) => {
      eventSocket = ws;
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected ARI server port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/ari`,
    authorization,
    sendEvent: (event) => {
      if (!eventSocket) {
        throw new Error("ARI event socket is not connected");
      }
      eventSocket.send(JSON.stringify(event));
    },
  };
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

beforeEach(() => {
  guardedJsonApiRequestMock.mockReset();
});

describe("AsteriskProvider", () => {
  it("originates through ARI and activates realtime media only after AudioSocket connects", async () => {
    const ari = await startAriEventServer();
    const audioSocketPort = await reservePort();
    const callId = "11111111-2222-4333-8444-555555555555";
    const requests: Array<{ method: string; url: URL }> = [];
    let audioSocket: Socket | undefined;
    guardedJsonApiRequestMock.mockImplementation(
      async (request: { method: string; url: string }) => {
        const url = new URL(request.url);
        requests.push({ method: request.method, url });
        if (url.pathname.endsWith("/channels/externalMedia")) {
          audioSocket = net.connect(audioSocketPort, "127.0.0.1");
          sockets.push(audioSocket);
          await new Promise<void>((resolve, reject) => {
            audioSocket?.once("connect", resolve);
            audioSocket?.once("error", reject);
          });
          audioSocket.write(encodeAudioSocketUuid(url.searchParams.get("data") ?? ""));
          return { id: url.searchParams.get("channelId"), state: "Up" };
        }
        if (request.method === "POST" && url.pathname.endsWith(`/channels/${callId}`)) {
          return { id: callId, state: "Down" };
        }
        return undefined;
      },
    );

    const receiveAudio = vi.fn();
    const stream: RealtimeTelephonyStream = {
      receiveAudio,
      acknowledgeMark: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const attachTelephonyStream = vi.fn(() => stream);
    const realtimeHandler: AsteriskRealtimeHandler = {
      attachTelephonyStream,
      speak: vi.fn(() => ({ success: true })),
    };
    const provider = new AsteriskProvider({
      baseUrl: ari.baseUrl,
      username: "openclaw",
      password: "secret",
      application: "openclaw",
      endpoint: "PJSIP/{number}@trunk",
      audioSocket: {
        bind: "127.0.0.1",
        host: "127.0.0.1",
        port: audioSocketPort,
      },
    });
    provider.setRealtimeHandler(realtimeHandler);
    const events: NormalizedEvent[] = [];
    await provider.startEventListener((event) => events.push(event));

    await expect(
      provider.initiateCall({
        callId,
        mode: "notify",
        from: "+15550001234",
        to: "+15550005678",
        webhookUrl: "http://127.0.0.1/unused",
      }),
    ).rejects.toThrow("conversation mode only");

    await provider.initiateCall({
      callId,
      mode: "conversation",
      from: "+15550001234",
      to: "+15550005678",
      webhookUrl: "http://127.0.0.1/unused",
    });

    const originate = requests[0];
    expect(originate?.method).toBe("POST");
    expect(originate?.url.pathname).toBe(`/ari/channels/${callId}`);
    expect(originate?.url.searchParams.get("endpoint")).toBe("PJSIP/+15550005678@trunk");
    expect(originate?.url.searchParams.get("app")).toBe("openclaw");
    expect(await ari.authorization).toBe(
      `Basic ${Buffer.from("openclaw:secret").toString("base64")}`,
    );

    ari.sendEvent({
      application: "openclaw",
      type: "ChannelStateChange",
      timestamp: "2026-08-27T12:00:00.000Z",
      channel: { id: callId, state: "Up" },
    });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "call.answered")).toBe(true);
    });

    const externalMedia = requests.find((request) =>
      request.url.pathname.endsWith("/channels/externalMedia"),
    );
    expect(externalMedia?.url.searchParams.get("encapsulation")).toBe("audiosocket");
    expect(externalMedia?.url.searchParams.get("transport")).toBe("tcp");
    expect(externalMedia?.url.searchParams.get("format")).toBe("slin");
    expect(externalMedia?.url.searchParams.get("data")).toBe(callId);
    expect(attachTelephonyStream).toHaveBeenCalledWith(
      expect.objectContaining({
        callId,
        providerCallId: callId,
        direction: "outbound",
      }),
    );

    ari.sendEvent({
      application: "openclaw",
      type: "ChannelDtmfReceived",
      timestamp: "2026-08-27T12:00:01.000Z",
      digit: "7",
      channel: { id: callId, state: "Up" },
    });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "call.dtmf" && event.digits === "7")).toBe(true);
    });

    await provider.stop();
  });
});
