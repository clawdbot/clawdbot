import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGatewayWebSocketUrl } from "../../lib/gateway-websocket-url.ts";

export type BrowserScreencastMeta = { url: string; title: string };
export type BrowserScreencastFrame = {
  blob: Blob;
  url: string;
  cssWidth: number;
  cssHeight: number;
};

type BrowserScreencastOptions = {
  gatewayUrl: string;
  wsPath: string;
  onReady: (meta: BrowserScreencastMeta & { targetId: string }) => void;
  onMeta: (meta: BrowserScreencastMeta) => void;
  onFrame: (frame: BrowserScreencastFrame) => void;
  onClose: (detail: { code: number; reason: string }) => void;
};

export class BrowserScreencastClient {
  private readonly socket: WebSocket;
  private closed = false;

  constructor(
    private readonly options: BrowserScreencastOptions,
    createWebSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {
    this.socket = createWebSocket(resolveGatewayWebSocketUrl(options.wsPath, options.gatewayUrl));
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("message", (event) => this.receive(event.data));
    this.socket.addEventListener("close", ({ code, reason }) => this.finish(code, reason));
    this.socket.addEventListener("error", () => {
      this.finish(1006, "");
      this.socket.close();
    });
  }

  close(): void {
    this.closed = true;
    this.socket.close();
  }

  private finish(code: number, reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.options.onClose({ code, reason });
  }

  private receive(data: unknown): void {
    if (this.closed) {
      return;
    }
    try {
      if (typeof data === "string") {
        const message = asRecord(JSON.parse(data));
        if (message?.type === "error") {
          this.finish(1011, "");
          this.socket.close();
          return;
        }
        if (typeof message?.url !== "string" || typeof message.title !== "string") {
          throw new Error("Invalid screencast metadata");
        }
        if (message.type === "ready" && typeof message.targetId === "string") {
          this.options.onReady({
            targetId: message.targetId,
            url: message.url,
            title: message.title,
          });
        } else if (message.type === "meta") {
          this.options.onMeta({ url: message.url, title: message.title });
        } else {
          throw new Error("Invalid screencast message");
        }
        return;
      }
      if (!(data instanceof ArrayBuffer) || data.byteLength < 5) {
        throw new Error("Invalid screencast frame");
      }
      const headerLength = new DataView(data).getUint32(0);
      if (headerLength === 0 || headerLength >= data.byteLength - 4) {
        throw new Error("Invalid screencast header length");
      }
      const header = asRecord(
        JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, headerLength))),
      );
      if (
        typeof header?.url !== "string" ||
        typeof header.cssWidth !== "number" ||
        !Number.isFinite(header.cssWidth) ||
        header.cssWidth <= 0 ||
        typeof header.cssHeight !== "number" ||
        !Number.isFinite(header.cssHeight) ||
        header.cssHeight <= 0
      ) {
        throw new Error("Invalid screencast dimensions");
      }
      this.options.onFrame({
        blob: new Blob([new Uint8Array(data, 4 + headerLength)], { type: "image/jpeg" }),
        url: header.url,
        cssWidth: header.cssWidth,
        cssHeight: header.cssHeight,
      });
    } catch {
      this.finish(1002, "");
      this.socket.close();
    }
  }
}
