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
  gatewayUrl?: string;
  onConnect?: () => void;
  onDisconnect?: (detail: DesktopDisconnectDetail) => void;
  onSecurityFailure?: (detail: DesktopSecurityFailureDetail) => void;
  password?: string;
  target: HTMLElement;
  viewOnly: boolean;
  wsUrl: string;
};

export type DesktopConnectionHandle = {
  disconnect(): void;
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
  options?: { credentials?: { password: string } },
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
    const socket = this.createWebSocket(wsUrl);
    let closeDetail: DesktopDisconnectDetail = {};
    socket.addEventListener("close", (event) => {
      closeDetail = { code: event.code, reason: event.reason };
    });
    const rfb = new Rfb(
      options.target,
      socket,
      options.password ? { credentials: { password: options.password } } : undefined,
    );
    rfb.background = options.background ?? getComputedStyle(options.target).backgroundColor;
    rfb.viewOnly = options.viewOnly;
    rfb.scaleViewport = true;
    rfb.addEventListener("connect", () => options.onConnect?.());
    rfb.addEventListener("disconnect", () => options.onDisconnect?.(closeDetail));
    rfb.addEventListener("securityfailure", (event) => {
      const detail = (event as CustomEvent<DesktopSecurityFailureDetail>).detail ?? {};
      options.onSecurityFailure?.(detail);
    });
    return {
      disconnect: () => rfb.disconnect(),
    };
  }
}
