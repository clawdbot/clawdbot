import type { ExtensionRelayBridge } from "./relay-bridge.js";
import type { ExtensionToRelayMessage, RelayToExtensionMessage } from "./relay-protocol.js";

/** In-memory socket capturing every frame the bridge sends. */
export class FakeSocket {
  readonly sent: unknown[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
  /** Frames of a given method (client CDP responses/events). */
  frames(): Array<Record<string, unknown>> {
    return this.sent as Array<Record<string, unknown>>;
  }
}

/**
 * Scripted extension: auto-answers relay commands so the bridge can complete
 * attach/CDP round-trips. Attach returns a deterministic targetId per tab.
 */
export function wireExtension(
  bridge: ExtensionRelayBridge,
  reply: (msg: RelayToExtensionMessage) => ExtensionToRelayMessage | null = replyFor,
) {
  const socket = new FakeSocket();
  const handlers = bridge.attachExtensionSocket(socket);
  // Auto-reply to commands the bridge issues to the extension.
  const originalSend = socket.send.bind(socket);
  socket.send = (data: string) => {
    originalSend(data);
    const msg = JSON.parse(data) as RelayToExtensionMessage;
    if (msg.type === "ping") {
      return;
    }
    queueMicrotask(() => {
      const response = reply(msg);
      if (response) {
        handlers.onMessage(JSON.stringify(response));
      }
    });
  };
  return { socket, handlers };
}

export function replyFor(msg: RelayToExtensionMessage): ExtensionToRelayMessage | null {
  switch (msg.type) {
    case "attach":
      return { type: "result", seq: msg.seq, result: { targetId: `target-${msg.tabId}` } };
    case "detach":
    case "activateTab":
    case "closeTab":
      return { type: "result", seq: msg.seq, result: {} };
    case "createTab":
      return { type: "result", seq: msg.seq, result: { tabId: 999 } };
    case "cdp":
      return { type: "result", seq: msg.seq, result: { ok: true, echoed: msg.method } };
    default:
      return null;
  }
}

export function sendHello(handlers: { onMessage: (raw: string) => void }, tabs = defaultTabs()) {
  handlers.onMessage(
    JSON.stringify({
      type: "hello",
      userAgent: "Mozilla/5.0 Chrome/144.0.0.0",
      browserVersion: "Chrome/144.0.0.0",
      extensionVersion: "2.0.0",
      tabs,
    }),
  );
}

export function defaultTabs() {
  return [{ tabId: 1, url: "https://example.com", title: "Example", active: true }];
}

export const flush = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
