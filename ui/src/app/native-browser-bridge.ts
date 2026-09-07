/**
 * Canonical macOS Browser bridge (DashboardBrowserMessageHandler mirrors these keys).
 * Handler: window.webkit.messageHandlers.openclawBrowser, Promise reply {ok:true,...}
 * or {ok:false,error}. Requests use type: open {tabId,url,activate?}, navigate
 * {tabId,url}, back/forward/reload/stop/close/snapshot {tabId}, inspect {tabId,x,y},
 * present {scope,tabId,rect:{x,y,width,height}|null,visible}, release-scope {scope}.
 * IDs and scopes are opaque; web-created IDs are `mac-` plus a generated UUID.
 * Open replies include tabId. The host reuses a tab at the requested URL or its
 * retained initial-request alias, so the returned ID may differ from the request.
 * The requesting panel selects that returned tab; it need not wait for a new tab.
 * Rects are dashboard viewport CSS pixels. Null tab/rect or invisible hides a scope.
 * Tabs are window-owned; release-scope never closes them. If scopes present the
 * same tab, the most recent presentation wins until it is hidden or released.
 * Push: __OPENCLAW_NATIVE_BROWSER__ plus openclaw:native-browser-state detail,
 * {revision,tabs:[{id,url,title,loading,canGoBack,canGoForward,openedBy,openerTabId?}]}.
 * Tabs are in creation order; openedBy is web|native. Snapshot adds dataUrl (PNG),
 * cssWidth,cssHeight; inspect adds node (BrowserInspectedNode|null).
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { BrowserInspectedNode } from "../components/browser/browser-client.ts";
import { hasNativeBrowserBridge } from "./native-browser-host.ts";

export { hasNativeBrowserBridge } from "./native-browser-host.ts";

export type NativeBrowserTab = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  openedBy: "web" | "native";
  openerTabId?: string;
};
export type NativeBrowserState = { revision: number; tabs: NativeBrowserTab[] };
type NativeBrowserRect = { x: number; y: number; width: number; height: number };
export type NativeBrowserMessage =
  | { type: "open"; tabId: string; url: string; activate?: boolean }
  | { type: "navigate"; tabId: string; url: string }
  | { type: "back" | "forward" | "reload" | "stop" | "close" | "snapshot"; tabId: string }
  | { type: "inspect"; tabId: string; x: number; y: number }
  | {
      type: "present";
      scope: string;
      tabId: string | null;
      rect: NativeBrowserRect | null;
      visible: boolean;
    }
  | { type: "release-scope"; scope: string };
export type NativeBrowserReply =
  | {
      ok: true;
      tabId?: string;
      dataUrl?: string;
      cssWidth?: number;
      cssHeight?: number;
      node?: BrowserInspectedNode | null;
    }
  | { ok: false; error: string };

type NativeBrowserWindow = Window & {
  __OPENCLAW_NATIVE_BROWSER__?: unknown;
  webkit?: {
    messageHandlers?: {
      openclawBrowser?: { postMessage(message: NativeBrowserMessage): Promise<unknown> };
    };
  };
};
const STATE_EVENT = "openclaw:native-browser-state";

function nativeWindow(): NativeBrowserWindow | undefined {
  return typeof window === "undefined" ? undefined : window;
}
function handler() {
  return nativeWindow()?.webkit?.messageHandlers?.openclawBrowser;
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function browserUrl(value: unknown): value is string {
  if (value === "about:blank") {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
function isRect(value: unknown): value is NativeBrowserRect {
  return (
    isRecord(value) &&
    finite(value.x) &&
    finite(value.y) &&
    finite(value.width) &&
    value.width >= 0 &&
    finite(value.height) &&
    value.height >= 0
  );
}
function validMessage(value: unknown): value is NativeBrowserMessage {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "release-scope") {
    return nonempty(value.scope);
  }
  if (value.type === "present") {
    return (
      nonempty(value.scope) &&
      (value.tabId === null || nonempty(value.tabId)) &&
      (value.rect === null || isRect(value.rect)) &&
      typeof value.visible === "boolean"
    );
  }
  if (!nonempty(value.tabId)) {
    return false;
  }
  switch (value.type) {
    case "open":
      return (
        browserUrl(value.url) &&
        (value.activate === undefined || typeof value.activate === "boolean")
      );
    case "navigate":
      return browserUrl(value.url);
    case "inspect":
      return finite(value.x) && value.x >= 0 && finite(value.y) && value.y >= 0;
    case "back":
    case "forward":
    case "reload":
    case "stop":
    case "close":
    case "snapshot":
      return true;
    default:
      return false;
  }
}
function isState(value: unknown): value is NativeBrowserState {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.revision !== "number" ||
    value.revision < 0 ||
    !Array.isArray(value.tabs)
  ) {
    return false;
  }
  const ids = new Set<string>();
  return Array.from(value.tabs).every((tab: unknown) => {
    if (
      !isRecord(tab) ||
      !nonempty(tab.id) ||
      ids.has(tab.id) ||
      !browserUrl(tab.url) ||
      typeof tab.title !== "string" ||
      typeof tab.loading !== "boolean" ||
      typeof tab.canGoBack !== "boolean" ||
      typeof tab.canGoForward !== "boolean" ||
      (tab.openedBy !== "web" && tab.openedBy !== "native") ||
      (tab.openerTabId !== undefined && !nonempty(tab.openerTabId))
    ) {
      return false;
    }
    ids.add(tab.id);
    return true;
  });
}
function isNode(value: unknown): value is BrowserInspectedNode | null {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.tag === "string" &&
      typeof value.id === "string" &&
      Array.isArray(value.classes) &&
      value.classes.every((entry: unknown) => typeof entry === "string") &&
      typeof value.role === "string" &&
      typeof value.name === "string" &&
      typeof value.focusable === "boolean" &&
      isRect(value.rect))
  );
}

export async function postNativeBrowserMessage(
  message: NativeBrowserMessage,
): Promise<NativeBrowserReply | null> {
  const bridge = handler();
  if (typeof bridge?.postMessage !== "function") {
    return null;
  }
  if (!validMessage(message)) {
    return { ok: false, error: "Invalid native browser request" };
  }
  try {
    const post = bridge.postMessage.bind(bridge);
    const reply = await post(message);
    if (isRecord(reply) && reply.ok === false && typeof reply.error === "string") {
      return { ok: false, error: reply.error };
    }
    if (!isRecord(reply) || reply.ok !== true) {
      return { ok: false, error: "Invalid native browser reply" };
    }
    if (message.type === "open") {
      return nonempty(reply.tabId)
        ? { ok: true, tabId: reply.tabId }
        : { ok: false, error: "Invalid native browser reply" };
    }
    if (message.type === "snapshot") {
      if (
        typeof reply.dataUrl !== "string" ||
        !reply.dataUrl.startsWith("data:image/png;base64,") ||
        !finite(reply.cssWidth) ||
        reply.cssWidth <= 0 ||
        !finite(reply.cssHeight) ||
        reply.cssHeight <= 0
      ) {
        return { ok: false, error: "Invalid native browser snapshot" };
      }
      return {
        ok: true,
        dataUrl: reply.dataUrl,
        cssWidth: reply.cssWidth,
        cssHeight: reply.cssHeight,
      };
    }
    if (message.type === "inspect") {
      return isNode(reply.node)
        ? { ok: true, node: reply.node }
        : { ok: false, error: "Invalid native browser inspection" };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Native browser request failed",
    };
  }
}
export function readNativeBrowserState(): NativeBrowserState | null {
  if (!hasNativeBrowserBridge()) {
    return null;
  }
  const value = nativeWindow()?.["__OPENCLAW_NATIVE_BROWSER__"];
  return isState(value) ? value : null;
}
export function subscribeNativeBrowserState(
  listener: (state: NativeBrowserState) => void,
): () => void {
  if (!hasNativeBrowserBridge()) {
    return () => {};
  }
  let revision = readNativeBrowserState()?.revision ?? -1;
  const onState = (event: Event) => {
    const state: unknown = event instanceof CustomEvent ? event.detail : null;
    if (isState(state) && state.revision > revision) {
      revision = state.revision;
      listener(state);
    }
  };
  window.addEventListener(STATE_EVENT, onState);
  return () => window.removeEventListener(STATE_EVENT, onState);
}
