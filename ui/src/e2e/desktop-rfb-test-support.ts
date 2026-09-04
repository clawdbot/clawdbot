import { deflateSync } from "node:zlib";
import type { Locator, Page } from "playwright";

export function createRfbClipboardProvide(format: 1 | 2): number[] {
  const text = Buffer.from("Clipboard continuity: Café Ω\0");
  const payload = Buffer.alloc(4 + text.length);
  payload.writeUInt32BE(text.length);
  text.copy(payload, 4);
  const compressed = deflateSync(payload);
  const message = Buffer.alloc(12 + compressed.length);
  message[0] = 3; // ServerCutText, extended Provide with a zlib-compressed format payload.
  message.writeInt32BE(-(4 + compressed.length), 4);
  message.writeUInt32BE(0x10000000 | format, 8);
  compressed.copy(message, 12);
  return [...message];
}

export function createRfbRawFrame(): number[] {
  const width = 96;
  const height = 64;
  const message = Buffer.alloc(16 + width * height * 4);
  message.writeUInt16BE(1, 2); // FramebufferUpdate with one Raw rectangle at (0, 0).
  message.writeUInt16BE(width, 8);
  message.writeUInt16BE(height, 10);
  for (let offset = 16; offset < message.length; offset += 4) {
    // noVNC requests little-endian RGBX32, independent of ServerInit's pixel format.
    message.set([24, 180, 160, 0], offset);
  }
  return [...message];
}

/** Count Desktop transport lifecycle calls without opening a real RFB socket. */
export async function installDesktopClientFake(panel: Locator): Promise<void> {
  await panel.evaluate((element) => {
    (
      element as HTMLElement & {
        desktopClientFactory: () => {
          connect(options: { credentials?: { username?: string; password?: string } }): Promise<{
            disconnect(): void;
            disableInput(): void;
          }>;
        };
      }
    ).desktopClientFactory = () => ({
      async connect(options) {
        element.dataset.connectCount = String(Number(element.dataset.connectCount ?? "0") + 1);
        element.dataset.usedCredentials = options.credentials?.password ? "true" : "false";
        return {
          disableInput() {},
          disconnect() {
            element.dataset.disconnectCount = String(
              Number(element.dataset.disconnectCount ?? "0") + 1,
            );
          },
        };
      },
    });
  });
}

/** Install the scripted RFB 3.8 endpoint used by Desktop's canonical noVNC E2E. */
export async function installScriptedRfbServer(
  page: Page,
  options: { disconnectAfterLastPeer?: boolean } = {},
) {
  await page.evaluate(({ disconnectAfterLastPeer }) => {
    const GatewaySocket = window.WebSocket;
    const sockets = new Set<FakeRfbSocket>();
    const events: string[] = [];
    let nextId = 0;
    let desktopTeardown = false;
    class FakeRfbSocket extends EventTarget {
      binaryType = "arraybuffer";
      protocol = "";
      readyState = 0;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;
      private closeHandler: ((event: CloseEvent) => void) | null = null;
      private readonly dispatchClose = (event: Event) => this.closeHandler?.(event as CloseEvent);
      get onclose() {
        return this.closeHandler;
      }
      set onclose(handler: ((event: CloseEvent) => void) | null) {
        // Native event-handler properties occupy their original registration position.
        if (!this.closeHandler && handler) {
          this.addEventListener("close", this.dispatchClose);
        } else if (this.closeHandler && !handler) {
          this.removeEventListener("close", this.dispatchClose);
        }
        this.closeHandler = handler;
      }
      private handshake = 0;
      private readonly id: number;
      authenticated = false;
      constructor() {
        super();
        nextId += 1;
        this.id = nextId;
        sockets.add(this);
        setTimeout(() => {
          if (this.readyState !== 0) {
            return;
          }
          this.readyState = 1;
          this.onopen?.(new Event("open"));
          this.deliver(new TextEncoder().encode("RFB 003.008\n"));
        }, 0);
      }
      deliver(bytes: Uint8Array<ArrayBuffer>): void {
        setTimeout(() => {
          if (this.readyState === 1) {
            this.onmessage?.(new MessageEvent("message", { data: bytes.buffer }));
          }
        }, 0);
      }
      send(): void {
        // Handshake replies are fixed-size, so respond by stage instead of
        // parsing: version -> security types, choice -> ok, init -> ServerInit.
        this.handshake += 1;
        if (this.handshake === 1) {
          this.deliver(new Uint8Array([1, 1]));
        } else if (this.handshake === 2) {
          this.deliver(new Uint8Array([0, 0, 0, 0]));
        } else if (this.handshake === 3) {
          if (desktopTeardown) {
            this.close(1000, "desktop stream closed");
            return;
          }
          this.authenticated = true;
          events.push(`authenticated:${this.id}`);
          const name = new TextEncoder().encode("scripted-desktop");
          const init = new Uint8Array(24 + name.length);
          const view = new DataView(init.buffer);
          view.setUint16(0, 800);
          view.setUint16(2, 600);
          init.set([32, 24, 0, 1], 4);
          view.setUint16(8, 255);
          view.setUint16(10, 255);
          view.setUint16(12, 255);
          init.set([16, 8, 0], 14);
          view.setUint32(20, name.length);
          init.set(name, 24);
          this.deliver(init);
        }
      }
      close(code = 1000, reason = ""): void {
        if (this.readyState >= 2) {
          return;
        }
        this.readyState = 2;
        // close() starts a handshake; native sockets deliver its event in a later task.
        setTimeout(() => {
          this.readyState = 3;
          sockets.delete(this);
          events.push(`closed:${this.id}`);
          if (
            disconnectAfterLastPeer &&
            this.authenticated &&
            ![...sockets].some((socket) => socket.authenticated)
          ) {
            // Model an old native desktop teardown crossing the replacement handshake.
            desktopTeardown = true;
          }
          this.dispatchEvent(new CloseEvent("close", { code, reason }));
        }, 0);
      }
    }
    const RoutedSocket = function (url: string, protocols?: string | string[]) {
      return url.includes("/desktop/observe")
        ? new FakeRfbSocket()
        : new GatewaySocket(url, protocols);
    };
    RoutedSocket.prototype = GatewaySocket.prototype;
    Object.assign(RoutedSocket, {
      CONNECTING: 0,
      OPEN: 1,
      CLOSING: 2,
      CLOSED: 3,
    });
    window.WebSocket = RoutedSocket as unknown as typeof WebSocket;
    (
      window as typeof window & { triggerDesktopRfbDisconnect?: (reason: string) => void }
    ).triggerDesktopRfbDisconnect = (reason) => {
      for (const socket of sockets) {
        socket.close(1006, reason);
      }
    };
    (window as typeof window & { desktopRfbEvents?: () => string[] }).desktopRfbEvents = () => [
      ...events,
    ];
    (window as typeof window & { desktopRfbSend?: (chunks: number[][]) => void }).desktopRfbSend = (
      chunks,
    ) => {
      for (const socket of sockets) {
        if (socket.authenticated && socket.readyState === 1) {
          for (const chunk of chunks) {
            socket.deliver(new Uint8Array(chunk));
          }
        }
      }
    };
  }, options);
  return {
    send: (chunks: number[][]) =>
      page.evaluate(
        (messages) =>
          (
            window as typeof window & { desktopRfbSend?: (chunks: number[][]) => void }
          ).desktopRfbSend?.(messages),
        chunks,
      ),
    disconnect: (reason: string) =>
      page.evaluate(
        (message) =>
          (
            window as typeof window & { triggerDesktopRfbDisconnect?: (reason: string) => void }
          ).triggerDesktopRfbDisconnect?.(message),
        reason,
      ),
    events: () =>
      page.evaluate(
        () =>
          (window as typeof window & { desktopRfbEvents?: () => string[] }).desktopRfbEvents?.() ??
          [],
      ),
  };
}
