type DesktopDisconnectDetail = {
  code?: number;
  reason?: string;
};

type DesktopSecurityFailureDetail = {
  reason?: string;
  status?: number;
};

type DesktopConnectOptions = {
  background?: string;
  credentials?: { username?: string; password?: string };
  gatewayUrl?: string;
  isCurrent: () => boolean;
  onConnect?: () => void;
  onDisconnect?: (detail: DesktopDisconnectDetail) => void;
  onSecurityFailure?: (detail: DesktopSecurityFailureDetail) => void;
  scaleViewport?: boolean;
  target: HTMLElement;
  viewOnly: boolean;
  wsUrl: string;
};

export type DesktopConnectionHandle = {
  disconnect(): void;
  disableInput(): void;
  sendBackspace?(): void;
  sendKeyboardEvent?(event: KeyboardEvent): void;
  sendText?(text: string): void;
  setScaleViewport?(enabled: boolean): void;
};

type RfbClient = EventTarget & {
  background: string;
  disconnect(): void;
  scaleViewport: boolean;
  viewOnly: boolean;
};

type RfbConstructor = new (
  target: HTMLElement,
  channel: string | WebSocket,
  options?: { credentials?: { username?: string; password?: string } },
) => RfbClient;

type RfbLoader = () => Promise<RfbConstructor>;
type WebSocketFactory = (url: string) => WebSocket;

const loadDefaultRfb: RfbLoader = async () => {
  // @novnc/novnc 1.7 exports RFB from the package root; keeping this import
  // here ensures the substantial client stays in the lazy desktop chunk.
  const module = (await import("@novnc/novnc")) as { default: RfbConstructor };
  return module.default;
};

function resolveDesktopWebSocketUrl(wsUrl: string, gatewayUrl = globalThis.location?.href): string {
  const base = new URL(gatewayUrl ?? globalThis.location.href, globalThis.location?.href);
  if (base.protocol === "http:") {
    base.protocol = "ws:";
  } else if (base.protocol === "https:") {
    base.protocol = "wss:";
  }
  const resolved = new URL(wsUrl, base);
  if (resolved.protocol === "http:") {
    resolved.protocol = "ws:";
  } else if (resolved.protocol === "https:") {
    resolved.protocol = "wss:";
  }
  if (resolved.protocol !== "ws:" && resolved.protocol !== "wss:") {
    throw new Error("Desktop observer URL must use WebSocket transport");
  }
  return resolved.toString();
}

/** Thin owner for one noVNC RFB lifecycle. */
export class DesktopClient {
  constructor(
    private readonly rfbConstructor?: RfbConstructor,
    private readonly createWebSocket: WebSocketFactory = (url) => new WebSocket(url),
    private readonly loadRfb: RfbLoader = loadDefaultRfb,
  ) {}

  async connect(options: DesktopConnectOptions): Promise<DesktopConnectionHandle> {
    const Rfb = this.rfbConstructor ?? (await this.loadRfb());
    const wsUrl = resolveDesktopWebSocketUrl(options.wsUrl, options.gatewayUrl);
    // The socket claims control before RFB authentication; canceled lazy loads must not open it.
    if (!options.isCurrent()) {
      throw new DOMException("Desktop connection is no longer current", "AbortError");
    }
    const socket = this.createWebSocket(wsUrl);
    let closeDetail: DesktopDisconnectDetail = {};
    socket.addEventListener("close", (event) => {
      closeDetail = { code: event.code, reason: event.reason };
    });
    const rfb = new Rfb(
      options.target,
      socket,
      options.credentials ? { credentials: options.credentials } : undefined,
    );
    rfb.background = options.background ?? getComputedStyle(options.target).backgroundColor;
    rfb.viewOnly = options.viewOnly;
    rfb.scaleViewport = options.scaleViewport ?? true;
    rfb.addEventListener("connect", () => options.onConnect?.());
    rfb.addEventListener("disconnect", () => options.onDisconnect?.(closeDetail));
    rfb.addEventListener("securityfailure", (event) => {
      const detail = (event as CustomEvent<DesktopSecurityFailureDetail>).detail ?? {};
      options.onSecurityFailure?.(detail);
    });
    const dispatchKeyboardEvent = (event: KeyboardEvent) => {
      // noVNC owns keyboard translation and attaches its listeners to the
      // canvas. Forward the offscreen mobile input's event to that same
      // boundary so virtual-keyboard input follows the canonical RFB path.
      options.target.querySelector("canvas")?.dispatchEvent(event);
    };
    const cloneKeyboardEvent = (event: KeyboardEvent) =>
      new KeyboardEvent(event.type, {
        key: event.key,
        code: event.code,
        location: event.location,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        repeat: event.repeat,
        isComposing: event.isComposing,
        bubbles: true,
        cancelable: true,
      });
    return {
      disconnect: () => rfb.disconnect(),
      disableInput: () => {
        rfb.viewOnly = true;
      },
      setScaleViewport: (enabled) => {
        rfb.scaleViewport = enabled;
      },
      sendKeyboardEvent: (event) => dispatchKeyboardEvent(cloneKeyboardEvent(event)),
      sendText: (text) => {
        // Mobile IMEs can omit keydown/keyup. "Unidentified" asks noVNC's
        // keyboard owner to translate each inserted character and emit a
        // balanced press/release. Line breaks need Enter rather than Unicode LF.
        const normalizedText = text.replace(/\r\n?/g, "\n");
        for (let index = 0; index < normalizedText.length; index += 1) {
          dispatchKeyboardEvent(
            new KeyboardEvent("keydown", {
              key: normalizedText.charAt(index) === "\n" ? "Enter" : normalizedText.charAt(index),
              code: "Unidentified",
              bubbles: true,
              cancelable: true,
            }),
          );
        }
      },
      sendBackspace: () => {
        for (const type of ["keydown", "keyup"]) {
          dispatchKeyboardEvent(
            new KeyboardEvent(type, {
              key: "Backspace",
              code: "Backspace",
              bubbles: true,
              cancelable: true,
            }),
          );
        }
      },
    };
  }
}
