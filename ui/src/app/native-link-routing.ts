import { promoteToPopoverTopLayer } from "../components/menu-surface.ts";
import { NativeLinkMenu, type NativeLinkMenuAction } from "../components/native-link-menu.ts";
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

type NativeLinkTarget = "inline" | "external";

type NativeLinkMessage = {
  type: "open-link";
  url: string;
  target: NativeLinkTarget;
};

type WebKitMessageHandler = {
  postMessage(message: NativeLinkMessage): void;
};

type NativeUpdateMessage = {
  type: "start-update";
};

type WebKitUpdateMessageHandler = {
  postMessage(message: NativeUpdateMessage): void;
};

export const NATIVE_UPDATE_DECLINED_EVENT = "openclaw:native-update-declined";
export const NATIVE_UPDATE_AVAILABILITY_CHANGED_EVENT =
  "openclaw:native-update-availability-changed";

type NativeLinkRouting = {
  dispose(): void;
};

type NativeLinkRoutingOptions = {
  shouldOpenInControlUiBrowser?: () => boolean;
};

function getNativeLinkPoster(): WebKitMessageHandler["postMessage"] | undefined {
  // Native hosts install this handler before navigation; its absence preserves browser behavior.
  const handler = (
    window as unknown as {
      webkit?: { messageHandlers?: { openclawLink?: WebKitMessageHandler } };
    }
  ).webkit?.messageHandlers?.openclawLink;
  return handler?.postMessage.bind(handler);
}

function getNativeUpdateHandler(): WebKitUpdateMessageHandler | undefined {
  return (
    window as unknown as {
      webkit?: { messageHandlers?: { openclawUpdate?: WebKitUpdateMessageHandler } };
    }
  ).webkit?.messageHandlers?.openclawUpdate;
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
  postMessage: WebKitMessageHandler["postMessage"],
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
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { dispose() {} };
  }
  const postMessage = getNativeLinkPoster();
  if (!postMessage && !options.shouldOpenInControlUiBrowser) {
    return { dispose() {} };
  }

  let menu: NativeLinkMenu | null = null;
  const closeMenu = (expected?: NativeLinkMenu) => {
    if (expected && menu !== expected) {
      return;
    }
    menu?.remove();
    menu = null;
  };
  const showMenu = (
    nativePostMessage: WebKitMessageHandler["postMessage"],
    anchor: HTMLAnchorElement,
    url: URL,
    x: number,
    y: number,
    container: HTMLElement,
  ) => {
    closeMenu();
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
      shouldHandleControlUiBrowserActivation(event) &&
      options.shouldOpenInControlUiBrowser?.()
    ) {
      window.dispatchEvent(
        new CustomEvent<BrowserPanelToggleDetail>(BROWSER_PANEL_TOGGLE_EVENT, {
          detail: { open: true, url: webLink.url.href },
        }),
      );
      closeMenu();
      event.preventDefault();
      return;
    }
    if (!postMessage || !shouldHandleNavigationClick(event)) {
      return;
    }
    const appLink = trustedExternalAppUrl(event);
    const link = appLink ?? webLink;
    const target = appLink ? "external" : "inline";
    if (!link || !postNativeLink(postMessage, link.url, target)) {
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
    showMenu(
      postMessage,
      link.anchor,
      link.url,
      event.clientX,
      event.clientY,
      menuContainer(event),
    );
  };

  // Run after target/document handlers so cancelled application actions remain authoritative.
  window.addEventListener("click", handleClick);
  window.addEventListener("auxclick", handleClick);
  // Capture keeps message-level context menus from replacing native link actions.
  if (postMessage) {
    document.addEventListener("contextmenu", handleContextMenu, true);
  }

  return {
    dispose() {
      window.removeEventListener("click", handleClick);
      window.removeEventListener("auxclick", handleClick);
      document.removeEventListener("contextmenu", handleContextMenu, true);
      closeMenu();
    },
  };
}
