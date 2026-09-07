export const NATIVE_HISTORY_STATE_EVENT = "openclaw:native-history-state";

export type NativeHistoryState = {
  canGoBack: boolean;
  canGoForward: boolean;
};

type NativeEmbedHost = {
  platform: "ios" | "macos" | "android";
  formFactor: "phone" | "pad" | "desktop";
};

type NativeWebChromeWindow = Window & {
  __OPENCLAW_NATIVE_EMBED__?: unknown;
  __OPENCLAW_NATIVE_WEB_CHROME__?: boolean;
  __OPENCLAW_NATIVE_HISTORY__?: NativeHistoryState;
};

export function isNativeWebChromeHost(): boolean {
  return (window as NativeWebChromeWindow)["__OPENCLAW_NATIVE_WEB_CHROME__"] === true;
}

export function nativeEmbedHost(): NativeEmbedHost | null {
  // SAFETY: the host adds this optional document-start value; its shape is validated below.
  const host = (window as NativeWebChromeWindow)["__OPENCLAW_NATIVE_EMBED__"];
  if (!host || typeof host !== "object" || Array.isArray(host)) {
    return null;
  }
  return "platform" in host &&
    (host.platform === "ios" || host.platform === "macos" || host.platform === "android") &&
    "formFactor" in host &&
    (host.formFactor === "phone" || host.formFactor === "pad" || host.formFactor === "desktop")
    ? { platform: host.platform, formFactor: host.formFactor }
    : null;
}

export function isNativeEmbedHost(): boolean {
  return nativeEmbedHost() !== null;
}

export function readNativeHistoryState(): NativeHistoryState {
  const state = (window as NativeWebChromeWindow)["__OPENCLAW_NATIVE_HISTORY__"];
  return state && typeof state.canGoBack === "boolean" && typeof state.canGoForward === "boolean"
    ? state
    : { canGoBack: false, canGoForward: false };
}
