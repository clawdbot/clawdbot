import { resolveGatewayWebSocketUrl } from "../../lib/gateway-websocket-url.ts";

export type DesktopDisconnectDetail = {
  clean: boolean;
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
  sendBackspace(): void;
  sendKeyboardEvent(event: KeyboardEvent): void;
  sendText(text: string): void;
  setScaleViewport(enabled: boolean): void;
};

type RfbClient = EventTarget & {
  background: string;
  disconnect(): void;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
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

/** Thin owner for one noVNC RFB lifecycle. */
export class DesktopClient {
  constructor(
    private readonly rfbConstructor?: RfbConstructor,
    private readonly createWebSocket: WebSocketFactory = (url) => new WebSocket(url),
    private readonly loadRfb: RfbLoader = loadDefaultRfb,
  ) {}

  async connect(options: DesktopConnectOptions): Promise<DesktopConnectionHandle> {
    const Rfb = this.rfbConstructor ?? (await this.loadRfb());
    const wsUrl = resolveGatewayWebSocketUrl(options.wsUrl, options.gatewayUrl);
    // The socket claims control before RFB authentication; canceled lazy loads must not open it.
    if (!options.isCurrent()) {
      throw new DOMException("Desktop connection is no longer current", "AbortError");
    }
    const socket = this.createWebSocket(wsUrl);
    let closeDetail: Pick<CloseEvent, "code" | "reason"> | undefined;
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
    let retired = false;
    rfb.addEventListener("connect", () => options.onConnect?.());
    rfb.addEventListener("disconnect", (event) => {
      // noVNC's terminal state is permanent; callbacks may synchronously retire this handle.
      retired = true;
      // SAFETY: noVNC's public disconnect event carries clean, even before the socket closes.
      const { clean } = (event as CustomEvent<{ clean: boolean }>).detail;
      options.onDisconnect?.({ ...closeDetail, clean });
    });
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
      disconnect: () => {
        if (!retired) {
          retired = true;
          rfb.disconnect();
        }
      },
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
        for (const character of normalizedText) {
          // noVNC 1.7's DOM key translator only accepts BMP characters. Its
          // public RFB sender supports the full Unicode scalar keysym directly.
          if (character.length === 2) {
            rfb.sendKey(0x01000000 | character.codePointAt(0)!, null);
            continue;
          }
          dispatchKeyboardEvent(
            new KeyboardEvent("keydown", {
              key: character === "\n" ? "Enter" : character,
              code: "Unidentified",
              bubbles: true,
              cancelable: true,
            }),
          );
        }
      },
      sendBackspace: () => rfb.sendKey(0xff08, "Backspace"),
    };
  }
}
