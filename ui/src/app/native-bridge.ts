// Application-owned native draft delivery.
type WebView2Bridge = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

export type NativeChatDrafts = {
  subscribe: (listener: (draft: string) => void) => () => void;
  dispose: () => void;
};

function getWebview(): WebView2Bridge | undefined {
  const webview = (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;
  return webview;
}

// Keep WebView2 messaging distinct from the DOM Window.postMessage contract.
function sendToNative(message: unknown): void {
  getWebview()?.postMessage(message);
}

function readNativeDraft(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== "string") {
    return null;
  }
  if (msg.type === "draft-text") {
    const text =
      msg.payload && typeof msg.payload === "object"
        ? (msg.payload as Record<string, unknown>).text
        : undefined;
    if (typeof text === "string") {
      return text;
    }
  }
  return null;
}

/**
 * Subscribes to WebView2 native messages and sends the ready handshake.
 * addEventListener is called BEFORE the ready handshake so no messages
 * are missed between the handshake and the first listen.
 * Drafts received while Chat is not mounted are retained for its next subscriber.
 */
export function createNativeChatDrafts(): NativeChatDrafts {
  const bridge = getWebview();
  if (!bridge) {
    return {
      subscribe: () => () => {},
      dispose: () => {},
    };
  }

  let pendingDraft: string | null = null;
  const listeners = new Set<(draft: string) => void>();
  const handler = (event: MessageEvent) => {
    const draft = readNativeDraft(event.data);
    if (draft === null) {
      return;
    }
    if (listeners.size === 0) {
      pendingDraft = draft;
      return;
    }
    for (const listener of listeners) {
      listener(draft);
    }
  };

  bridge.addEventListener("message", handler);
  sendToNative({ type: "ready" });

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (pendingDraft !== null) {
        const draft = pendingDraft;
        pendingDraft = null;
        listener(draft);
      }
      return () => listeners.delete(listener);
    },
    dispose() {
      listeners.clear();
      pendingDraft = null;
      bridge.removeEventListener("message", handler);
    },
  };
}
