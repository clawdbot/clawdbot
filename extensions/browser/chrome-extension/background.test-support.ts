import { vi } from "vitest";

export const AUTH_INSTANCE_ID = "ICEiIyQlJicoKSorLC0uLw";
export const AUTH_SESSION_ID = "MDEyMzQ1Njc4OTo7PD0-Pw";
export const AUTH_SERVER_NONCE = "YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8";

type SocketEvent = { data?: unknown };
type SocketListener = (event: SocketEvent) => void;

export type RuntimeMessageListener = (
  message: {
    type: string;
    tabId?: number;
    note?: string;
    pairingString?: string;
    accessMode?: string;
    grant?: boolean;
  },
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean;

let configuredSockets: FakeWebSocket[] = [];
let configuredDeferredClose = false;
let configuredProtocol: string | undefined;

export function configureFakeWebSockets(options: {
  sockets: FakeWebSocket[];
  deferSocketClose: boolean;
  relayNegotiatedProtocol?: string;
}): void {
  configuredSockets = options.sockets;
  configuredDeferredClose = options.deferSocketClose;
  configuredProtocol = options.relayNegotiatedProtocol;
}

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  readonly protocol: string;
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    if (configuredDeferredClose) {
      this.readyState = FakeWebSocket.CLOSING;
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  });
  private readonly listeners = new Map<string, SocketListener[]>();

  constructor(
    readonly url: string,
    readonly protocols: string[] = [],
  ) {
    this.protocol = protocols.includes("openclaw-extension-relay.v2")
      ? (configuredProtocol ?? "openclaw-extension-relay.v2")
      : (protocols[0] ?? "");
    configuredSockets.push(this);
  }

  addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  receive(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  finishClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  private emit(type: string, event: SocketEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}
