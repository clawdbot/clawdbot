import net, { type Server, type Socket } from "node:net";
import { convertPcmToMulaw8k, mulawToPcm } from "openclaw/plugin-sdk/realtime-voice";
import type {
  RealtimeCarrierSocket,
  RealtimeCallEndCause,
  RealtimeTelephonyStream,
} from "../webhook/realtime-handler.js";
import type { StreamFrameAdapter } from "../webhook/stream-frame-adapter.js";

const AUDIO_SOCKET_KIND_HANGUP = 0x00;
const AUDIO_SOCKET_KIND_UUID = 0x01;
const AUDIO_SOCKET_KIND_DTMF = 0x03;
const AUDIO_SOCKET_KIND_PCM16_8KHZ = 0x10;
const AUDIO_SOCKET_KIND_ERROR = 0xff;
const AUDIO_SOCKET_HEADER_BYTES = 3;
const AUDIO_SOCKET_UUID_BYTES = 16;
const MAX_BUFFERED_INPUT_BYTES = 256 * 1024;
const CARRIER_OPEN = 1;
const CARRIER_CLOSED = 3;

function encodeAudioSocketFrame(kind: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > 0xffff) {
    throw new Error(`AudioSocket payload exceeds 65535 bytes: ${payload.length}`);
  }
  const frame = Buffer.allocUnsafe(AUDIO_SOCKET_HEADER_BYTES + payload.length);
  frame[0] = kind;
  frame.writeUInt16BE(payload.length, 1);
  payload.copy(frame, AUDIO_SOCKET_HEADER_BYTES);
  return frame;
}

function decodeAudioSocketUuid(payload: Buffer): string | null {
  if (payload.length !== AUDIO_SOCKET_UUID_BYTES) {
    return null;
  }
  const hex = payload.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

class AsteriskAudioSocketCarrier implements RealtimeCarrierSocket {
  constructor(private readonly socket: Socket) {}

  get readyState(): number {
    return this.socket.destroyed ? CARRIER_CLOSED : CARRIER_OPEN;
  }

  get bufferedAmount(): number {
    return this.socket.writableLength;
  }

  send(message: string | Buffer): void {
    if (typeof message === "string") {
      throw new Error("AudioSocket carrier only accepts binary frames");
    }
    if (message.length > 0 && !this.socket.destroyed) {
      this.socket.write(message);
    }
  }

  close(): void {
    if (!this.socket.destroyed) {
      this.socket.end(encodeAudioSocketFrame(AUDIO_SOCKET_KIND_HANGUP));
    }
  }
}

class AsteriskAudioSocketFrameAdapter implements StreamFrameAdapter {
  readonly providerName = "asterisk" as const;
  readonly acknowledgeMarksOnSend = true;

  parseInbound(): ReturnType<StreamFrameAdapter["parseInbound"]> {
    return { kind: "ignored" };
  }

  serializeMedia(payloadBase64: string): Buffer {
    const decoded = Buffer.from(payloadBase64, "base64");
    const muLaw = Buffer.alloc(decoded.length);
    decoded.copy(muLaw);
    const pcm = mulawToPcm(muLaw);
    return encodeAudioSocketFrame(AUDIO_SOCKET_KIND_PCM16_8KHZ, pcm);
  }

  serializeClear(): Buffer {
    return Buffer.alloc(0);
  }

  serializeMark(): Buffer {
    return Buffer.alloc(0);
  }
}

export type AsteriskAudioSocketSession = {
  callId: string;
  carrier: RealtimeCarrierSocket;
  adapter: StreamFrameAdapter;
};

type AudioSocketSessionBinding = {
  stream: RealtimeTelephonyStream;
  onDtmf: (digit: string) => void;
};

export class AsteriskAudioSocketServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private stopping = false;

  constructor(
    private readonly config: { bind: string; port: number },
    private readonly onSession: (
      session: AsteriskAudioSocketSession,
    ) => AudioSocketSessionBinding | null,
  ) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.stopping = false;
    const server = net.createServer((socket) => this.handleConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        if (this.server === server) {
          this.server = null;
        }
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        server.on("error", (error) => {
          console.error("[voice-call] Asterisk AudioSocket server error:", error);
        });
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.config.port, this.config.bind);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    let buffered = Buffer.alloc(0);
    let binding: AudioSocketSessionBinding | null = null;
    let closed = false;

    const closeBinding = (cause: RealtimeCallEndCause) => {
      if (closed) {
        return;
      }
      closed = true;
      if (binding) {
        void binding.stream.close(cause);
      }
    };
    const rejectConnection = (message: string) => {
      console.warn(`[voice-call] Rejecting Asterisk AudioSocket connection: ${message}`);
      socket.destroy();
    };

    socket.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffered = Buffer.concat([buffered, bytes]);
      if (buffered.length > MAX_BUFFERED_INPUT_BYTES) {
        rejectConnection("input buffer exceeded limit");
        return;
      }
      while (buffered.length >= AUDIO_SOCKET_HEADER_BYTES) {
        const kind = buffered[0] ?? AUDIO_SOCKET_KIND_ERROR;
        const payloadLength = buffered.readUInt16BE(1);
        const frameLength = AUDIO_SOCKET_HEADER_BYTES + payloadLength;
        if (buffered.length < frameLength) {
          return;
        }
        const payload = buffered.subarray(AUDIO_SOCKET_HEADER_BYTES, frameLength);
        buffered = buffered.subarray(frameLength);

        if (!binding) {
          if (kind !== AUDIO_SOCKET_KIND_UUID) {
            rejectConnection("first frame was not a UUID");
            return;
          }
          const callId = decodeAudioSocketUuid(payload);
          if (!callId) {
            rejectConnection("UUID frame was malformed");
            return;
          }
          binding = this.onSession({
            callId,
            carrier: new AsteriskAudioSocketCarrier(socket),
            adapter: new AsteriskAudioSocketFrameAdapter(),
          });
          if (!binding) {
            rejectConnection(`unknown call ${callId}`);
            return;
          }
          continue;
        }

        if (kind === AUDIO_SOCKET_KIND_PCM16_8KHZ) {
          if (payload.length % 2 !== 0) {
            rejectConnection("PCM payload had an odd byte length");
            return;
          }
          binding.stream.receiveAudio(convertPcmToMulaw8k(payload, 8_000));
          continue;
        }
        if (kind === AUDIO_SOCKET_KIND_DTMF && payload.length === 1) {
          binding.onDtmf(String.fromCharCode(payload[0] ?? 0));
          continue;
        }
        if (kind === AUDIO_SOCKET_KIND_HANGUP) {
          socket.end();
          return;
        }
        if (kind === AUDIO_SOCKET_KIND_ERROR) {
          rejectConnection(`Asterisk reported AudioSocket error ${payload.toString("hex")}`);
          return;
        }
        rejectConnection(`unsupported frame type 0x${kind.toString(16)}`);
        return;
      }
    });
    socket.on("error", (error) => {
      console.warn(`[voice-call] Asterisk AudioSocket connection error: ${error.message}`);
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      closeBinding(this.stopping ? "shutdown" : "disconnect");
    });
  }
}
