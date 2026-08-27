import crypto from "node:crypto";
import net, { type Server, type Socket } from "node:net";
import { convertPcmToMulaw8k, mulawToPcm } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AsteriskAudioSocketServer,
  type AsteriskAudioSocketSession,
} from "./asterisk-audiosocket.js";

const servers: Server[] = [];
const sockets: Socket[] = [];

function encodeFrame(kind: number, payload: Buffer): Buffer {
  const frame = Buffer.alloc(3 + payload.length);
  frame[0] = kind;
  frame.writeUInt16BE(payload.length, 1);
  payload.copy(frame, 3);
  return frame;
}

function encodeUuid(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function connect(port: number): Promise<Socket> {
  const socket = net.connect(port, "127.0.0.1");
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
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

describe("AsteriskAudioSocketServer", () => {
  it("round-trips fragmented UUID and PCM frames through the realtime carrier boundary", async () => {
    const port = await reservePort();
    const callId = crypto.randomUUID();
    const pcm = Buffer.alloc(320);
    pcm.writeInt16LE(12_000, 0);
    const receiveAudio = vi.fn();
    let session: AsteriskAudioSocketSession | undefined;
    let resolveInbound: (() => void) | undefined;
    const inbound = new Promise<void>((resolve) => {
      resolveInbound = resolve;
    });
    const server = new AsteriskAudioSocketServer({ bind: "127.0.0.1", port }, (next) => {
      session = next;
      return {
        stream: {
          receiveAudio: (audio) => {
            receiveAudio(audio);
            resolveInbound?.();
          },
          acknowledgeMark: vi.fn(),
          close: vi.fn(async () => {}),
        },
        onDtmf: vi.fn(),
      };
    });
    await server.start();

    const socket = await connect(port);
    const uuidFrame = encodeFrame(0x01, encodeUuid(callId));
    const audioFrame = encodeFrame(0x10, pcm);
    socket.write(uuidFrame.subarray(0, 5));
    socket.write(Buffer.concat([uuidFrame.subarray(5), audioFrame.subarray(0, 7)]));
    socket.write(audioFrame.subarray(7));
    await inbound;

    expect(session?.callId).toBe(callId);
    expect(receiveAudio).toHaveBeenCalledWith(convertPcmToMulaw8k(pcm, 8_000));

    const outbound = new Promise<Buffer>((resolve) => {
      socket.once("data", resolve);
    });
    const muLaw = Buffer.from([0xff, 0x7f, 0x00]);
    const encoded = session?.adapter.serializeMedia(muLaw.toString("base64"));
    if (!encoded || !session) {
      throw new Error("expected AudioSocket session");
    }
    session.carrier.send(encoded);

    const response = await outbound;
    expect(response[0]).toBe(0x10);
    expect(response.readUInt16BE(1)).toBe(muLaw.length * 2);
    expect(response.subarray(3)).toEqual(mulawToPcm(muLaw));

    await server.stop();
  });
});
