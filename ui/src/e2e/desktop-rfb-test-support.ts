import type { Page } from "playwright";

/** Install the scripted RFB 3.8 endpoint used by Desktop's canonical noVNC E2E. */
export async function installScriptedRfbServer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const GatewaySocket = window.WebSocket;
    const sockets = new Set<FakeRfbSocket>();
    class FakeRfbSocket extends EventTarget {
      binaryType = "arraybuffer";
      protocol = "";
      readyState = 0;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      private handshake = 0;
      constructor() {
        super();
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
      private deliver(bytes: Uint8Array<ArrayBuffer>): void {
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
        if (this.readyState === 3) {
          return;
        }
        this.readyState = 3;
        sockets.delete(this);
        const event = new CloseEvent("close", { code, reason });
        this.onclose?.(event);
        this.dispatchEvent(new CloseEvent("close", { code, reason }));
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
  });
}
