/**
 * Wire protocol between the extension relay server and the OpenClaw Chrome
 * extension. The extension stays a dumb transport: it attaches chrome.debugger,
 * forwards CDP traffic, and manages the OpenClaw tab group. All CDP target
 * semantics (Target.* synthesis for Playwright) live server-side in the bridge.
 */

/** Tab snapshot reported by the extension for tabs shared with OpenClaw. */
export type RelayTabInfo = {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
};

export const PAGE_SHARE_MAX_NOTE_CHARS = 2_000;
export const PAGE_SHARE_MAX_TITLE_CHARS = 500;
export const PAGE_SHARE_MAX_URL_CHARS = 2_000;

/** Page-share payload captured by the extension on explicit user action. */
export type PageSharePayload = {
  url: string;
  title: string;
  /** Extracted readable page text (already truncated extension-side). */
  content: string;
  /** User-highlighted selection; preferred over content when present. */
  selection?: string;
  /** Short user-typed note; trusted (typed by the user in the popup). */
  note?: string;
};

/** First message the extension sends after the WebSocket opens. */
type ExtensionHelloMessage = {
  type: "hello";
  userAgent: string;
  /** Full browser product string, e.g. "Chrome/144.0.7204.49". */
  browserVersion: string;
  extensionVersion: string;
  tabs: RelayTabInfo[];
};

/** Full refresh of shared tabs; sent on any group membership or tab change. */
type ExtensionTabsMessage = {
  type: "tabs";
  tabs: RelayTabInfo[];
};

/** CDP event emitted by an attached tab (child sessions carry sessionId). */
type ExtensionCdpEventMessage = {
  type: "cdpEvent";
  tabId: number;
  sessionId?: string;
  method: string;
  params?: unknown;
};

/** Successful response to a relay command (cdp/attach/createTab/...). */
type ExtensionResultMessage = {
  type: "result";
  seq: number;
  result?: unknown;
};

/** Failed response to a relay command. */
type ExtensionErrorMessage = {
  type: "error";
  seq: number;
  message: string;
};

/** chrome.debugger detached outside relay control (infobar cancel, tab gone). */
type ExtensionDetachedMessage = {
  type: "detached";
  tabId: number;
  reason: string;
};

/** Keepalive reply; message traffic keeps the MV3 service worker alive. */
type ExtensionPongMessage = {
  type: "pong";
};

type ExtensionPageShareMessage = {
  type: "pageShare";
  requestId: number;
  payload: PageSharePayload;
};

export type ExtensionToRelayMessage =
  | ExtensionHelloMessage
  | ExtensionTabsMessage
  | ExtensionCdpEventMessage
  | ExtensionResultMessage
  | ExtensionErrorMessage
  | ExtensionDetachedMessage
  | ExtensionPongMessage
  | ExtensionPageShareMessage;

/**
 * Command bodies sent to the extension. The bridge assigns the `seq` used to
 * correlate the extension's result/error reply.
 */
export type RelayCommandBody =
  /** Forward a CDP command into an attached tab (or one of its child sessions). */
  | { type: "cdp"; tabId: number; sessionId?: string; method: string; params?: unknown }
  /** Attach chrome.debugger to a shared tab. Result: { targetId: string }. */
  | { type: "attach"; tabId: number }
  /** Detach chrome.debugger from a tab (tab left the group or client detached). */
  | { type: "detach"; tabId: number }
  /** Open a new tab inside the OpenClaw tab group. Result: { tabId: number }. */
  | { type: "createTab"; url: string; background?: boolean }
  /** Close a shared tab. Result: {}. */
  | { type: "closeTab"; tabId: number }
  /** Focus a shared tab (window + tab activation). Result: {}. */
  | { type: "activateTab"; tabId: number };

/** Keepalive probe; the extension answers with pong. */
type RelayPingMessage = {
  type: "ping";
};

export type RelayPageShareResultMessage = {
  type: "pageShareResult";
  requestId: number;
  ok: boolean;
  error?: string;
};

export type RelayToExtensionMessage =
  | (RelayCommandBody & { seq: number })
  | RelayPingMessage
  | RelayPageShareResultMessage;

/** Parse one extension frame; returns null for malformed input. */
export function parseExtensionMessage(raw: string): ExtensionToRelayMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string") {
    return null;
  }
  switch (type) {
    case "hello":
    case "tabs":
    case "cdpEvent":
    case "result":
    case "error":
    case "detached":
    case "pong":
    case "pageShare":
      return parsed as ExtensionToRelayMessage;
    default:
      return null;
  }
}
