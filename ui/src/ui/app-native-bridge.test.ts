import { afterEach, describe, expect, it, vi } from "vitest";
import { initNativeBridge, isWebView2, sendToNative } from "./app-native-bridge.ts";
import {
  handleChatDraftChange as applyDraftChange,
  navigateChatInputHistory,
  type ChatInputHistoryState,
} from "./chat/input-history.ts";

type FakeBridge = {
  postMessage: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  listeners: ((e: MessageEvent) => void)[];
  posted: unknown[];
};

function makeBridge(): FakeBridge {
  const listeners: ((e: MessageEvent) => void)[] = [];
  const posted: unknown[] = [];
  const bridge: FakeBridge = {
    posted,
    listeners,
    postMessage: vi.fn((msg: unknown) => posted.push(msg)),
    addEventListener: vi.fn((_type: string, fn: (e: MessageEvent) => void) => listeners.push(fn)),
    removeEventListener: vi.fn((_type: string, fn: (e: MessageEvent) => void) => {
      const i = listeners.indexOf(fn);
      if (i !== -1) {
        listeners.splice(i, 1);
      }
    }),
  };
  vi.stubGlobal("chrome", { webview: bridge });
  return bridge;
}

function makeHost() {
  return { handleChatDraftChange: vi.fn() };
}

function dispatch(bridge: FakeBridge, data: unknown) {
  const event = { data } as MessageEvent;
  for (const fn of bridge.listeners) {
    fn(event);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isWebView2", () => {
  it("returns false when window.chrome.webview is absent", () => {
    expect(isWebView2()).toBe(false);
  });

  it("returns true when window.chrome.webview is present", () => {
    makeBridge();
    expect(isWebView2()).toBe(true);
  });
});

describe("sendToNative", () => {
  it("posts the message to the webview", () => {
    const bridge = makeBridge();
    sendToNative({ type: "ready" });
    expect(bridge.posted).toEqual([{ type: "ready" }]);
  });

  it("does nothing outside WebView2", () => {
    expect(sendToNative({ type: "ready" })).toBeUndefined();
  });
});

describe("initNativeBridge", () => {
  it("registers listener before sending ready handshake", () => {
    const callOrder: string[] = [];
    const webview = {
      postMessage: vi.fn(() => callOrder.push("post")),
      addEventListener: vi.fn(() => callOrder.push("listen")),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("chrome", { webview });
    initNativeBridge(makeHost());
    expect(callOrder).toEqual(["listen", "post"]);
  });

  it("sends ready handshake on init", () => {
    const bridge = makeBridge();
    initNativeBridge(makeHost());
    expect(bridge.posted).toEqual([{ type: "ready" }]);
  });

  it("is a no-op outside WebView2", () => {
    const host = makeHost();
    const cleanup = initNativeBridge(host);
    expect(host.handleChatDraftChange).not.toHaveBeenCalled();
    expect(cleanup()).toBeUndefined();
  });

  it("calls handleChatDraftChange for a valid draft-text message", () => {
    const bridge = makeBridge();
    const host = makeHost();
    initNativeBridge(host);
    dispatch(bridge, { type: "draft-text", payload: { text: "hello from native" } });
    expect(host.handleChatDraftChange).toHaveBeenCalledWith("hello from native");
  });

  it("ignores draft-text with missing payload", () => {
    const bridge = makeBridge();
    const host = makeHost();
    initNativeBridge(host);
    dispatch(bridge, { type: "draft-text" });
    expect(host.handleChatDraftChange).not.toHaveBeenCalled();
  });

  it("ignores draft-text with non-string text", () => {
    const bridge = makeBridge();
    const host = makeHost();
    initNativeBridge(host);
    dispatch(bridge, { type: "draft-text", payload: { text: 42 } });
    dispatch(bridge, { type: "draft-text", payload: { text: null } });
    expect(host.handleChatDraftChange).not.toHaveBeenCalled();
  });

  it("ignores unknown message types", () => {
    const bridge = makeBridge();
    const host = makeHost();
    initNativeBridge(host);
    dispatch(bridge, { type: "recording-start" });
    dispatch(bridge, { type: "voice-start" });
    expect(host.handleChatDraftChange).not.toHaveBeenCalled();
  });

  it("ignores null, primitives, and messages without a type string", () => {
    const bridge = makeBridge();
    const host = makeHost();
    initNativeBridge(host);
    dispatch(bridge, null);
    dispatch(bridge, "string");
    dispatch(bridge, 42);
    dispatch(bridge, {});
    dispatch(bridge, { type: 99 });
    expect(host.handleChatDraftChange).not.toHaveBeenCalled();
  });

  it("removes the listener on cleanup", () => {
    const bridge = makeBridge();
    const host = makeHost();
    const cleanup = initNativeBridge(host);
    expect(bridge.listeners).toHaveLength(1);
    const registeredListener = bridge.listeners[0];
    cleanup();
    expect(bridge.listeners).toHaveLength(0);
    expect(bridge.removeEventListener).toHaveBeenCalledWith("message", registeredListener);
  });

  it("does not call handleChatDraftChange after cleanup", () => {
    const bridge = makeBridge();
    const host = makeHost();
    const cleanup = initNativeBridge(host);
    cleanup();
    dispatch(bridge, { type: "draft-text", payload: { text: "after cleanup" } });
    expect(host.handleChatDraftChange).not.toHaveBeenCalled();
  });

  it("draft-text resets input-history navigation — same effect as a user edit", () => {
    const bridge = makeBridge();

    const state: ChatInputHistoryState = {
      sessionKey: "s1",
      chatLoading: false,
      chatMessage: "",
      chatMessages: [],
      chatLocalInputHistoryBySession: { s1: [{ text: "previous input", ts: 1 }] },
      chatInputHistorySessionKey: null,
      chatInputHistoryItems: null,
      chatInputHistoryIndex: -1,
      chatDraftBeforeHistory: null,
    };

    // Simulate the user having navigated into history (index is now active).
    navigateChatInputHistory(state, "up");
    expect(state.chatInputHistoryIndex).toBe(0);

    // Host delegates to the real handleChatDraftChange — same path as app.ts.
    const host = { handleChatDraftChange: (text: string) => applyDraftChange(state, text) };
    initNativeBridge(host);

    dispatch(bridge, { type: "draft-text", payload: { text: "native injection" } });

    expect(state.chatMessage).toBe("native injection");
    expect(state.chatInputHistoryIndex).toBe(-1);
    expect(state.chatInputHistoryItems).toBeNull();
    expect(state.chatInputHistorySessionKey).toBeNull();
  });
});
