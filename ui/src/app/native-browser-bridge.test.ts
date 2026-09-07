/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasNativeBrowserBridge,
  postNativeBrowserMessage,
  readNativeBrowserState,
  subscribeNativeBrowserState,
  type NativeBrowserMessage,
} from "./native-browser-bridge.ts";

const tab = {
  id: "mac-1",
  url: "https://example.com/",
  title: "Example",
  loading: false,
  canGoBack: false,
  canGoForward: true,
  openedBy: "web",
};
function install(postMessage = vi.fn().mockResolvedValue({ ok: true })) {
  vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: { postMessage } } });
  return postMessage;
}
afterEach(() => vi.unstubAllGlobals());

describe("native browser bridge wire contract", () => {
  it("is inert outside the native host", async () => {
    const listener = vi.fn();
    expect(hasNativeBrowserBridge()).toBe(false);
    expect(readNativeBrowserState()).toBeNull();
    expect(await postNativeBrowserMessage({ type: "close", tabId: "mac-1" })).toBeNull();
    const unsubscribe = subscribeNativeBrowserState(listener);
    window.dispatchEvent(
      new CustomEvent("openclaw:native-browser-state", { detail: { revision: 1, tabs: [tab] } }),
    );
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });

  it.each([
    { type: "open", tabId: "mac-1", url: "javascript:alert(1)" },
    { type: "navigate", tabId: "mac-1", url: "file:///private/example" },
    { type: "open", tabId: "", url: "about:blank" },
    { type: "open", tabId: "mac-1", url: "https://example.com", activate: "true" },
    { type: "inspect", tabId: "mac-1", x: Number.NaN, y: 4 },
    {
      type: "present",
      scope: "scope",
      tabId: "mac-1",
      visible: true,
      rect: { x: 0, y: 0, width: -1, height: 30 },
    },
    { type: "present", scope: "", tabId: null, rect: null, visible: false },
    { type: "unknown", tabId: "mac-1" },
  ])("rejects malformed or unsupported request %j before calling WebKit", async (message) => {
    const post = install();
    expect(await postNativeBrowserMessage(message as NativeBrowserMessage)).toMatchObject({
      ok: false,
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("binds WebKit's receiver and preserves valid request values", async () => {
    const messages: NativeBrowserMessage[] = [];
    const bridge = {
      postMessage(message: NativeBrowserMessage) {
        expect(this).toBe(bridge);
        messages.push(message);
        return Promise.resolve(
          message.type === "open" ? { ok: true, tabId: message.tabId } : { ok: true },
        );
      },
    };
    vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: bridge } });
    for (const message of [
      { type: "open", tabId: "mac-1", url: "about:blank", activate: false },
      { type: "present", scope: "scope", tabId: null, rect: null, visible: false },
      { type: "release-scope", scope: "scope" },
    ] satisfies NativeBrowserMessage[]) {
      expect(await postNativeBrowserMessage(message)).toEqual(
        message.type === "open" ? { ok: true, tabId: message.tabId } : { ok: true },
      );
    }
    expect(messages).toEqual([
      { type: "open", tabId: "mac-1", url: "about:blank", activate: false },
      { type: "present", scope: "scope", tabId: null, rect: null, visible: false },
      { type: "release-scope", scope: "scope" },
    ]);
  });

  it("rejects malformed snapshots and propagates native failures", async () => {
    const post = install();
    post.mockResolvedValueOnce({
      ok: true,
      dataUrl: "data:image/png;base64,eA==",
      cssWidth: 640,
      cssHeight: 480,
    });
    expect(await postNativeBrowserMessage({ type: "snapshot", tabId: "mac-1" })).toEqual({
      ok: true,
      dataUrl: "data:image/png;base64,eA==",
      cssWidth: 640,
      cssHeight: 480,
    });
    for (const reply of [
      null,
      { ok: true },
      { ok: true, dataUrl: "file:///example", cssWidth: 640, cssHeight: 480 },
      { ok: true, dataUrl: "data:image/png;base64,eA==", cssWidth: 0, cssHeight: 480 },
    ]) {
      post.mockResolvedValueOnce(reply);
      expect(await postNativeBrowserMessage({ type: "snapshot", tabId: "mac-1" })).toMatchObject({
        ok: false,
      });
    }
    post.mockResolvedValueOnce({ ok: false, error: "Tab closed" });
    expect(await postNativeBrowserMessage({ type: "reload", tabId: "mac-1" })).toEqual({
      ok: false,
      error: "Tab closed",
    });
    post.mockRejectedValueOnce(new Error("WebKit unavailable"));
    expect(await postNativeBrowserMessage({ type: "close", tabId: "mac-1" })).toEqual({
      ok: false,
      error: "WebKit unavailable",
    });
  });

  it("validates initial state and ignores malformed, duplicate, stale, and unsubscribed pushes", () => {
    install();
    vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", { revision: 2, tabs: [tab] });
    expect(readNativeBrowserState()).toEqual({ revision: 2, tabs: [tab] });
    const listener = vi.fn();
    const unsubscribe = subscribeNativeBrowserState(listener);
    const push = (detail: unknown) =>
      window.dispatchEvent(new CustomEvent("openclaw:native-browser-state", { detail }));
    for (const state of [
      { revision: 1, tabs: [tab] },
      { revision: 2, tabs: [] },
      { revision: 3, tabs: [tab, tab] },
      { revision: 3, tabs: [{ ...tab, openedBy: "other" }] },
      { revision: 3, tabs: [{ ...tab, loading: 1 }] },
      { revision: 3, tabs: [{ ...tab, url: "file:///example" }] },
      { revision: 3.5, tabs: [] },
    ]) {
      push(state);
    }
    expect(listener).not.toHaveBeenCalled();
    push({ revision: 3, tabs: [{ ...tab, openedBy: "native", openerTabId: "mac-opener" }] });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    push({ revision: 4, tabs: [] });
    expect(listener).toHaveBeenCalledOnce();
    vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", { revision: 5, tabs: [tab, tab] });
    expect(readNativeBrowserState()).toBeNull();
  });
});
