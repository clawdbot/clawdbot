import type { RouteId } from "../app-routes.ts";
import { isNativeWebChromeHost } from "./native-web-chrome.ts";

const MOBILE_NAV_MAX_WIDTH = 1100;
const NATIVE_WEB_CHROME_MOBILE_NAV_MAX_WIDTH = 600;
const NATIVE_SHELL_CLASSES = [
  "openclaw-native-macos",
  "openclaw-native-nav",
  "openclaw-native-web-chrome",
] as const;

export function mobileNavLayoutMediaQuery(): string {
  const maxWidth = isNativeWebChromeHost()
    ? NATIVE_WEB_CHROME_MOBILE_NAV_MAX_WIDTH
    : MOBILE_NAV_MAX_WIDTH;
  return `(max-width: ${maxWidth}px)`;
}

export function isMobileNavLayout(): boolean {
  return globalThis.matchMedia?.(mobileNavLayoutMediaQuery()).matches ?? false;
}

function hasNativeShellClass(): boolean {
  return NATIVE_SHELL_CLASSES.some((className) =>
    document.documentElement.classList.contains(className),
  );
}

export function shouldMergeChatChrome(params: {
  mobileNavLayout: boolean;
  routeId: RouteId;
  onboarding: boolean;
}): boolean {
  return (
    params.mobileNavLayout &&
    params.routeId === "chat" &&
    !params.onboarding &&
    !hasNativeShellClass()
  );
}
