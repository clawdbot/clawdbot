import { promoteToPopoverTopLayer } from "../components/menu-surface.ts";
import type {
  NativeLinkMenu,
  NativeLinkMenuAction,
} from "../components/native-link-menu.runtime.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  type BrowserPanelToggleDetail,
} from "../components/panel-toggle-contract.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import {
  anchorFromNavigationEvent,
  externalHttpLinkFromEvent,
  shouldHandleNavigationClick,
} from "../lib/navigation-click.ts";
import { hasNativeBrowserBridge } from "./native-browser-host.ts";
import { webKitHostWindow, type WebKitHostMessages } from "./native-webkit-bridge.ts";

type NativeLinkTarget = "external";
type NativeLinkPoster = (message: WebKitHostMessages["openclawLink"]) => void;

const NATIVE_UPDATE_DECLINED_EVENT = "openclaw:native-update-declined";
export const NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT =
  "openclaw:native-update-availability-changed";
const NATIVE_UPDATE_POSTED_EVENT = "openclaw:native-update-posted";

type NativeLinkRouting = {
  dispose(): void;
};

type NativeLinkRoutingOptions = {
  signal?: AbortSignal;
  onNativeUpdateDeclined?: () => void;
  shouldOpenInControlUiBrowser?: () => boolean;
  canPresentBrowserPanel?: () => boolean;
};

function getNativeLinkPoster(): NativeLinkPoster | undefined {
  // Native hosts install this handler before navigation; its absence preserves browser behavior.
  const handler = webKitHostWindow()?.webkit?.messageHandlers?.openclawLink;
  return handler?.postMessage.bind(handler);
}

function getNativeUpdateHandler() {
  return webKitHostWindow()?.webkit?.messageHandlers?.openclawUpdate;
}

export function hasNativeUpdateBridge(): boolean {
  return getNativeUpdateHandler() !== undefined;
}

export function postNativeUpdate(): boolean {
  const handler = getNativeUpdateHandler();
  if (!handler) {
    return false;
  }
  // Bound single-argument WebKit handler call, not window.postMessage;
  // binding also keeps oxlint's targetOrigin rule out of the wrong context.
  const poster = handler.postMessage.bind(handler);
  poster({ type: "start-update" });
  window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_POSTED_EVENT));
  return true;
}

function trustedExternalAppUrl(event: MouseEvent): { anchor: HTMLAnchorElement; url: URL } | null {
  if (!event.isTrusted) {
    return null;
  }
  const anchor = anchorFromNavigationEvent(event);
  if (!anchor || anchor.hasAttribute("download") || anchor.hasAttribute("data-file-path")) {
    return null;
  }
  try {
    const url = new URL(anchor.href, window.location.href);
    return url.protocol === "mailto:" || url.protocol === "tel:" ? { anchor, url } : null;
  } catch {
    return null;
  }
}

function menuContainer(event: Event): HTMLElement {
  const path = event.composedPath();
  const modalHost = path.find(
    (target) => target instanceof HTMLElement && target.localName === "openclaw-modal-dialog",
  );
  if (modalHost instanceof HTMLElement) {
    // Keep the menu in the modal's light-DOM slot so global menu styles still apply.
    return modalHost;
  }
  for (const target of path) {
    if (target instanceof HTMLDialogElement && target.open && target.getRootNode() === document) {
      return target;
    }
  }
  return document.body;
}

function postNativeLink(
  postMessage: NativeLinkPoster,
  url: URL,
  target: NativeLinkTarget,
): boolean {
  try {
    postMessage({ type: "open-link", url: url.href, target });
    return true;
  } catch {
    return false;
  }
}

export function postNativeExternalLink(url: string): boolean {
  const poster = getNativeLinkPoster();
  if (!poster) {
    return false;
  }
  try {
    return postNativeLink(poster, new URL(url), "external");
  } catch {
    return false;
  }
}

function openBrowserPanel(url: URL): void {
  window.dispatchEvent(
    new CustomEvent<BrowserPanelToggleDetail>(BROWSER_PANEL_TOGGLE_EVENT, {
      detail: { open: true, url: url.href, ...(hasNativeBrowserBridge() ? { native: true } : {}) },
    }),
  );
}

function shouldHandleControlUiBrowserActivation(event: MouseEvent): boolean {
  return (
    !event.defaultPrevented &&
    !event.shiftKey &&
    !event.altKey &&
    ((event.type === "click" && event.button === 0) ||
      (event.type === "auxclick" && event.button === 1))
  );
}

export function startNativeLinkRouting(options: NativeLinkRoutingOptions = {}): NativeLinkRouting {
  if (options.signal?.aborted || typeof window === "undefined" || typeof document === "undefined") {
    return { dispose() {} };
  }
  const postMessage = getNativeLinkPoster();
  if (
    !postMessage &&
    !hasNativeBrowserBridge() &&
    !options.shouldOpenInControlUiBrowser &&
    !options.onNativeUpdateDeclined
  ) {
    return { dispose() {} };
  }
  let menu: NativeLinkMenu | null = null;
  let menuModule: Promise<unknown> | undefined;
  let menuRequest = 0;
  let disposed = false;
  let nativeUpdatePending = false;
  const handleNativeUpdatePosted = () => {
    nativeUpdatePending = true;
  };
  const handleNativeUpdateDeclined = () => {
    if (!nativeUpdatePending) {
      return;
    }
    nativeUpdatePending = false;
    options.onNativeUpdateDeclined?.();
  };
  const closeMenu = (expected?: NativeLinkMenu) => {
    if (expected && menu !== expected) {
      return;
    }
    menuRequest += 1;
    menu?.remove();
    menu = null;
  };
  const showMenu = async (
    nativePostMessage: NativeLinkPoster,
    anchor: HTMLAnchorElement,
    url: URL,
    x: number,
    y: number,
    container: HTMLElement,
  ) => {
    closeMenu();
    const request = menuRequest;
    await (menuModule ??= import("../components/native-link-menu.runtime.ts"));
    // A later click, shutdown, or removed trigger invalidates this pending menu.
    if (
      disposed ||
      options.signal?.aborted ||
      request !== menuRequest ||
      !anchor.isConnected ||
      !container.isConnected
    ) {
      return;
    }
    const nextMenu = document.createElement("openclaw-native-link-menu") as NativeLinkMenu;
    nextMenu.x = x;
    nextMenu.y = y;
    nextMenu.trigger = anchor;
    nextMenu.onClose = () => closeMenu(nextMenu);
    nextMenu.onAction = (action: NativeLinkMenuAction) => {
      if (action === "copy") {
        void copyToClipboard(url.href);
        return;
      }
      if (action === "inline") {
        if (hasNativeBrowserBridge() && options.canPresentBrowserPanel?.() === false) {
          postNativeLink(nativePostMessage, url, "external");
        } else {
          openBrowserPanel(url);
        }
        return;
      }
      postNativeLink(nativePostMessage, url, action);
    };
    menu = nextMenu;
    container.append(nextMenu);
    promoteToPopoverTopLayer(nextMenu);
  };

  const handleClick = (event: MouseEvent) => {
    const webLink = externalHttpLinkFromEvent(event);
    if (
      webLink &&
      (hasNativeBrowserBridge()
        ? shouldHandleNavigationClick(event)
        : shouldHandleControlUiBrowserActivation(event)) &&
      (hasNativeBrowserBridge() || options.shouldOpenInControlUiBrowser?.())
    ) {
      if (hasNativeBrowserBridge() && options.canPresentBrowserPanel?.() === false) {
        if (postMessage) {
          postNativeLink(postMessage, webLink.url, "external");
        }
      } else {
        openBrowserPanel(webLink.url);
      }
      closeMenu();
      event.preventDefault();
      return;
    }
    if (!postMessage || !shouldHandleNavigationClick(event)) {
      return;
    }
    const appLink = trustedExternalAppUrl(event);
    if (!appLink || !postNativeLink(postMessage, appLink.url, "external")) {
      return;
    }
    closeMenu();
    event.preventDefault();
  };
  const handleContextMenu = (event: MouseEvent) => {
    if (!postMessage || event.defaultPrevented) {
      return;
    }
    const link = externalHttpLinkFromEvent(event);
    if (!link) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void showMenu(
      postMessage,
      link.anchor,
      link.url,
      event.clientX,
      event.clientY,
      menuContainer(event),
    ).catch((error: unknown) => {
      menuModule = undefined;
      if (!disposed) {
        console.error("[openclaw] native link menu failed to load; right-click to retry", error);
      }
    });
  };

  // Run after target/document handlers so cancelled application actions remain authoritative.
  window.addEventListener("click", handleClick);
  window.addEventListener("auxclick", handleClick);
  window.addEventListener(NATIVE_UPDATE_POSTED_EVENT, handleNativeUpdatePosted);
  window.addEventListener(NATIVE_UPDATE_DECLINED_EVENT, handleNativeUpdateDeclined);
  // Capture keeps message-level context menus from replacing native link actions.
  if (postMessage) {
    document.addEventListener("contextmenu", handleContextMenu, true);
  }

  const dispose = () => {
    disposed = true;
    options.signal?.removeEventListener("abort", dispose);
    window.removeEventListener("click", handleClick);
    window.removeEventListener("auxclick", handleClick);
    window.removeEventListener(NATIVE_UPDATE_POSTED_EVENT, handleNativeUpdatePosted);
    window.removeEventListener(NATIVE_UPDATE_DECLINED_EVENT, handleNativeUpdateDeclined);
    document.removeEventListener("contextmenu", handleContextMenu, true);
    closeMenu();
  };
  options.signal?.addEventListener("abort", dispose, { once: true });
  return { dispose };
}
