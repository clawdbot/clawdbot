import type { Locator, Page } from "playwright";

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
      onclose: ((event: CloseEvent) => void) | null = null;
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
        if (this.readyState === 3) {
          return;
        }
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
    (window as typeof window & { desktopRfbEvents?: () => string[] }).desktopRfbEvents = () => [
      ...events,
    ];
  }, options);
  return {
    events: () =>
      page.evaluate(
        () =>
          (window as typeof window & { desktopRfbEvents?: () => string[] }).desktopRfbEvents?.() ??
          [],
      ),
  };
}
