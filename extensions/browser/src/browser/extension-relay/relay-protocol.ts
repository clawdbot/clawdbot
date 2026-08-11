/**
 * Wire protocol between the extension relay server and the OpenClaw Chrome
 * extension. The extension owns tab eligibility/access, attaches chrome.debugger,
 * and forwards CDP traffic. All CDP target semantics (Target.* synthesis for
 * Playwright) live server-side in the bridge.
 */

/** Tab snapshot reported by the extension for tabs currently accessible to OpenClaw. */
export type RelayTabInfo = {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
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

/** Full refresh of accessible tabs; sent on any access-policy or tab change. */
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

export type ExtensionToRelayMessage =
  | ExtensionHelloMessage
  | ExtensionTabsMessage
  | ExtensionCdpEventMessage
  | ExtensionResultMessage
  | ExtensionErrorMessage
  | ExtensionDetachedMessage
  | ExtensionPongMessage;

/**
 * Command bodies sent to the extension. The bridge assigns the `seq` used to
 * correlate the extension's result/error reply.
 */
export type RelayCommandBody =
  /** Forward a CDP command into an attached tab (or one of its child sessions). */
  | { type: "cdp"; tabId: number; sessionId?: string; method: string; params?: unknown }
  /** Attach chrome.debugger to an accessible tab. Result: { targetId: string }. */
  | { type: "attach"; tabId: number }
  /** Detach chrome.debugger from a tab (access revoked or client detached). */
  | { type: "detach"; tabId: number }
  /** Open a new tab inside the OpenClaw tab group. Result: { tabId: number }. */
  | { type: "createTab"; url: string; background?: boolean; focus?: boolean }
  /** Close an accessible tab. Result: {}. */
  | { type: "closeTab"; tabId: number }
  /** Focus an accessible tab (window + tab activation). Result: {}. */
  | { type: "activateTab"; tabId: number };

/** Keepalive probe; the extension answers with pong. */
type RelayPingMessage = {
  type: "ping";
};

export type RelayToExtensionMessage = (RelayCommandBody & { seq: number }) | RelayPingMessage;

function hasExactOwnKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRelayTabInfo(value: unknown): value is RelayTabInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!hasExactOwnKeys(value, ["tabId", "url", "title", "active"])) {
    return false;
  }
  const tab = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(tab.tabId) &&
    (tab.tabId as number) >= 0 &&
    typeof tab.url === "string" &&
    tab.url.length <= 16_384 &&
    typeof tab.title === "string" &&
    tab.title.length <= 4_096 &&
    typeof tab.active === "boolean"
  );
}

function isExtensionHelloMessage(value: object): value is ExtensionHelloMessage {
  if (
    !hasExactOwnKeys(value, ["type", "userAgent", "browserVersion", "extensionVersion", "tabs"])
  ) {
    return false;
  }
  const hello = value as Record<string, unknown>;
  if (
    hello.type !== "hello" ||
    typeof hello.userAgent !== "string" ||
    hello.userAgent.length === 0 ||
    hello.userAgent.length > 2_048 ||
    typeof hello.browserVersion !== "string" ||
    hello.browserVersion.length === 0 ||
    hello.browserVersion.length > 512 ||
    typeof hello.extensionVersion !== "string" ||
    hello.extensionVersion.length === 0 ||
    hello.extensionVersion.length > 128 ||
    !Array.isArray(hello.tabs) ||
    hello.tabs.length > 1_000 ||
    !hello.tabs.every(isRelayTabInfo)
  ) {
    return false;
  }
  const tabIds = new Set(hello.tabs.map((tab) => tab.tabId));
  return tabIds.size === hello.tabs.length;
}

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
      return isExtensionHelloMessage(parsed) ? parsed : null;
    case "tabs":
    case "cdpEvent":
    case "result":
    case "error":
    case "detached":
    case "pong":
      return parsed as ExtensionToRelayMessage;
    default:
      return null;
  }
}
