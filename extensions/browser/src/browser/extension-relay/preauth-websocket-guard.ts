import type { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import type { RawData, WebSocket, WebSocketServer } from "ws";

export const MAX_WEBSOCKET_AUTH_MESSAGE_BYTES = 16 * 1024;
// A masked 16 KiB frame needs at most 8 bytes of framing. Keep a small bounded
// allowance for a few fragments without approaching the 64 MiB app limit.
const MAX_WEBSOCKET_PREAUTH_WIRE_BYTES = MAX_WEBSOCKET_AUTH_MESSAGE_BYTES + 1024;

export function boundedRawDataByteLength(data: RawData, limit: number): number {
  if (!Array.isArray(data)) {
    return data.byteLength;
  }
  let length = 0;
  for (const chunk of data) {
    length += chunk.byteLength;
    if (length > limit) {
      break;
    }
  }
  return length;
}

class PreAuthWebSocketTransport extends Duplex {
  private guardActive = true;
  private wireBytes: number;

  constructor(
    private readonly rawSocket: Duplex,
    headBytes: number,
  ) {
    super();
    this.wireBytes = headBytes;
    rawSocket.on("data", this.onRawData);
    rawSocket.once("end", this.onRawEnd);
    rawSocket.once("close", this.onRawClose);
    rawSocket.once("error", this.onRawError);
  }

  removeGuard = () => {
    this.guardActive = false;
  };

  override _read(): void {
    this.rawSocket.resume();
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.rawSocket.write(chunk, encoding, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.rawSocket.end(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.rawSocket.off("data", this.onRawData);
    this.rawSocket.off("end", this.onRawEnd);
    // A failed write can destroy this wrapper before the raw error event runs.
    // Keep terminal listeners until raw close, even when already destroyed.
    this.rawSocket.destroy();
    callback(error);
  }

  private readonly onRawData = (chunk: Buffer) => {
    if (this.guardActive) {
      this.wireBytes += chunk.byteLength;
      if (this.wireBytes > MAX_WEBSOCKET_PREAUTH_WIRE_BYTES) {
        this.destroy();
        return;
      }
    }
    if (!this.push(chunk)) {
      this.rawSocket.pause();
    }
  };

  private readonly onRawEnd = () => this.push(null);
  private readonly onRawClose = () => {
    this.rawSocket.off("error", this.onRawError);
    this.destroy();
  };
  private readonly onRawError = (error: Error) => this.destroy(error);
}

/** Withhold pre-auth bytes from `ws`; successful proof makes the transport transparent. */
export function handlePreAuthWebSocketUpgrade(params: {
  wss: WebSocketServer;
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  onUpgrade: (ws: WebSocket, removePreAuthGuard: () => void) => void;
}): boolean {
  if (params.head.byteLength > MAX_WEBSOCKET_PREAUTH_WIRE_BYTES) {
    return false;
  }
  const transport = new PreAuthWebSocketTransport(params.socket, params.head.byteLength);
  try {
    params.wss.handleUpgrade(params.req, transport, params.head, (ws) => {
      params.onUpgrade(ws, transport.removeGuard);
    });
  } catch (err) {
    transport.destroy();
    throw err;
  }
  return true;
}
