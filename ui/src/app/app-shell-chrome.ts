import { isSettingsNavigationRoute } from "../app-navigation.ts";
import { isSessionRouteId, routeIdFromPath, type RouteId } from "../app-route-paths.ts";
import {
  COMMAND_PALETTE_OPEN_EVENT,
  COMMAND_PALETTE_TARGET_EVENT,
  isCommandPaletteShortcut,
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  type CommandPaletteElement,
  type CommandPaletteTargetDetail,
  type ShellNavDrawerToggleDetail,
} from "../components/command-palette-contract.ts";
import type { OpenClawModalDialog } from "../components/modal-dialog.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  DEBUG_OVERLAY_REQUEST_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  isTerminalPanelShortcut,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import { rememberSessionPanelToggle } from "../components/session-panel-toggle-buffer.ts";
import type { BoardFace } from "../lib/board/settings.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { resolveAsciiShortcutKey } from "../lib/keyboard-shortcuts.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { isTerminalAvailable } from "../lib/terminal-availability.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "./context.ts";
import {
  DEBUG_OVERLAY_ELEMENT,
  isOptionalElementDefined,
  type LazyCustomElementRequestController,
  type OptionalCustomElement,
} from "./lazy-custom-element.ts";
import {
  clearLazyShellAction,
  lazyShellEvent,
  persistLazyShellAction,
  readLazyShellAction,
  SHELL_APPROVALS_OPEN_EVENT,
  type LazyShellEvent,
} from "./lazy-shell-action.ts";
import { isMobileNavLayout } from "./mobile-nav-layout.ts";
import {
  NATIVE_HISTORY_STATE_EVENT,
  readNativeHistoryState,
  type NativeHistoryState,
} from "./native-web-chrome.ts";
import { hasOperatorAdminAccess } from "./operator-access.ts";
import { NAV_WIDTH_MAX, NAV_WIDTH_MIN } from "./settings.ts";

type AppSidebarElement = HTMLElement & {
  dismissTransientMenus: () => boolean;
};

type DebugOverlayElement = HTMLElement & {
  toggle: () => void;
};

export function isBrowserPanelAvailable(
  snapshot: ApplicationContext["gateway"]["snapshot"],
): boolean {
  return (
    snapshot.phase === "connected" &&
    hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
    isGatewayMethodAdvertised(snapshot, "browser.request") === true
  );
}

export function isDesktopPanelAvailable(
  snapshot: ApplicationContext["gateway"]["snapshot"],
): boolean {
  return (
    snapshot.phase === "connected" &&
    hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
    isGatewayMethodAdvertised(snapshot, "desktop.observe") === true
  );
}

export interface ShellChromeHost extends HTMLElement {
  readonly context: ApplicationContext<RouteId> | undefined;
  readonly activeSessionKey: string;
  readonly onboardingMode: boolean;
  readonly updateComplete: Promise<boolean>;
  readonly lazyCustomElements: LazyCustomElementRequestController;
  readonly commandPaletteElement: OptionalCustomElement;
  readonly terminalPanelElement: OptionalCustomElement;
  readonly browserPanelElement: OptionalCustomElement;
  readonly desktopPanelElement: OptionalCustomElement;
  readonly custodianPanelElement: OptionalCustomElement;
  readonly execApprovalElement: OptionalCustomElement;
  readonly commandPalette: CommandPaletteElement | undefined;
  readonly approvalOverlay: (HTMLElement & { show(): void; dialogOpen?: boolean }) | undefined;
  routeState: ShellRouteState;
  navDrawerOpen: boolean;
  desktopNavigationExpanded: boolean;
  navDrawerTrigger: HTMLElement | null;
  nativeHistoryState: NativeHistoryState;
  commandPaletteTarget: CommandPaletteTargetDetail | undefined;
  pendingNativeNewSession: boolean;
  requestUpdate(): void;
  closeNavDrawer(options?: { restoreFocus?: boolean }): void;
  exitSettings(): void;
  navigate(routeId: string, options?: ApplicationNavigationOptions): void;
  openNewSession(agentId: string): void;
  chatNavigationOptions(
    face: BoardFace,
    options?: ApplicationNavigationOptions,
  ): ApplicationNavigationOptions | undefined;
}

export class ShellChromeOwner {
  private pendingLazyAction = readLazyShellAction();

  constructor(private readonly host: ShellChromeHost) {}

  private isSessionRoute(): boolean {
    const locationRouteId = routeIdFromPath(
      globalThis.location?.pathname ?? "",
      this.host.context?.basePath ?? "",
    );
    return isSessionRouteId(locationRouteId ?? this.host.routeState.routeId);
  }

  connect(): void {
    const host = this.host;
    host.nativeHistoryState = readNativeHistoryState();
    host.addEventListener(COMMAND_PALETTE_TARGET_EVENT, this.handleCommandPaletteTarget);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, this.handleCommandPaletteOpen);
    window.addEventListener(SHELL_NAV_DRAWER_TOGGLE_EVENT, this.handleShellNavDrawerToggle);
    window.addEventListener(DEBUG_OVERLAY_REQUEST_EVENT, this.handleDebugOverlayRequest);
    document.addEventListener("keydown", this.handleDocumentKeydown);
    window.addEventListener("resize", this.handleWindowResize);
    window.addEventListener("dragover", this.handleUnhandledFileDrag);
    window.addEventListener("drop", this.handleUnhandledFileDrag);
    window.addEventListener(NATIVE_HISTORY_STATE_EVENT, this.handleNativeHistoryState);
    // Shipped Mac hosts use these same events even when native web chrome is absent.
    window.addEventListener("openclaw:native-toggle-sidebar", this.handleNativeToggleSidebar);
    window.addEventListener("openclaw:native-open-search", this.handleNativeOpenSearch);
    window.addEventListener("openclaw:native-toggle-search", this.handleNativeToggleSearch);
    window.addEventListener("openclaw:native-new-session", this.handleNativeNewSession);
    window.addEventListener("openclaw:native-navigate", this.handleNativeNavigate);
    window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, this.handleDeferredTerminalToggle);
    window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, this.handleDeferredBrowserToggle);
    window.addEventListener(DESKTOP_PANEL_TOGGLE_EVENT, this.handleDeferredDesktopToggle);
    window.addEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, this.handleDeferredCustodianToggle);
    window.addEventListener(SHELL_APPROVALS_OPEN_EVENT, this.handleApprovalsOpen);
  }

  disconnect(): void {
    const host = this.host;
    host.removeEventListener(COMMAND_PALETTE_TARGET_EVENT, this.handleCommandPaletteTarget);
    window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, this.handleCommandPaletteOpen);
    window.removeEventListener(SHELL_NAV_DRAWER_TOGGLE_EVENT, this.handleShellNavDrawerToggle);
    window.removeEventListener(DEBUG_OVERLAY_REQUEST_EVENT, this.handleDebugOverlayRequest);
    document.removeEventListener("keydown", this.handleDocumentKeydown);
    window.removeEventListener("resize", this.handleWindowResize);
    window.removeEventListener("dragover", this.handleUnhandledFileDrag);
    window.removeEventListener("drop", this.handleUnhandledFileDrag);
    window.removeEventListener(NATIVE_HISTORY_STATE_EVENT, this.handleNativeHistoryState);
    window.removeEventListener("openclaw:native-toggle-sidebar", this.handleNativeToggleSidebar);
    window.removeEventListener("openclaw:native-open-search", this.handleNativeOpenSearch);
    window.removeEventListener("openclaw:native-toggle-search", this.handleNativeToggleSearch);
    window.removeEventListener("openclaw:native-new-session", this.handleNativeNewSession);
    window.removeEventListener("openclaw:native-navigate", this.handleNativeNavigate);
    window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, this.handleDeferredTerminalToggle);
    window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, this.handleDeferredBrowserToggle);
    window.removeEventListener(DESKTOP_PANEL_TOGGLE_EVENT, this.handleDeferredDesktopToggle);
    window.removeEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, this.handleDeferredCustodianToggle);
    window.removeEventListener(SHELL_APPROVALS_OPEN_EVENT, this.handleApprovalsOpen);
  }

  toggleNavigationSurface(trigger?: HTMLElement): void {
    const host = this.host;
    const context = host.context;
    // Desktop settings takeover has no app nav; its mobile drawer still owns navigation.
    if (!context || host.onboardingMode || (this.isSettingsTakeover() && !isMobileNavLayout())) {
      return;
    }
    if (isMobileNavLayout()) {
      if (host.navDrawerOpen) {
        host.closeNavDrawer({ restoreFocus: true });
        return;
      }
      host.navDrawerTrigger = trigger ?? host.querySelector<HTMLElement>(".topbar-nav-toggle");
      host.navDrawerOpen = true;
      return;
    }
    // A responsive handoff expands this shell without overwriting the desktop preference.
    const nextNavCollapsed =
      host.navDrawerOpen ||
      !(context.navigation.snapshot.navCollapsed && !host.desktopNavigationExpanded);
    const activeElement = host.ownerDocument.activeElement;
    const expansionTrigger =
      !nextNavCollapsed &&
      activeElement instanceof HTMLElement &&
      activeElement.matches(".shell-chrome-controls__nav-toggle")
        ? activeElement
        : trigger;
    host.desktopNavigationExpanded = false;
    if (nextNavCollapsed) {
      this.dismissSidebarTransientMenus();
    }
    host.closeNavDrawer();
    context.navigation.update({ navCollapsed: nextNavCollapsed });
    if (nextNavCollapsed) {
      void host.updateComplete.then(() => {
        this.restoreFocusTo(host.querySelector<HTMLElement>(".shell-chrome-controls__nav-toggle"));
      });
    } else if (expansionTrigger) {
      void host.updateComplete.then(() => {
        if (!expansionTrigger.isConnected) {
          this.restoreFocusTo(host.querySelector<HTMLElement>(".sidebar-brand__collapse"));
        }
      });
    }
  }

  /** Native Mac chrome hides in-page toggles, so restoration falls back to content. */
  restoreFocusTo(target: HTMLElement | null | undefined): void {
    const resolved =
      target?.isConnected && target.checkVisibility()
        ? target
        : this.host.querySelector<HTMLElement>(".content");
    resolved?.focus();
  }

  visibleNavDrawerToggle(): HTMLElement | undefined {
    return [
      ...this.host.querySelectorAll<HTMLElement>(".topbar-nav-toggle, .chat-pane__nav-toggle"),
    ].find((candidate) => candidate.checkVisibility());
  }

  closeNavDrawer(options: { restoreFocus?: boolean } = {}): void {
    const host = this.host;
    if (host.navDrawerOpen) {
      this.dismissSidebarTransientMenus();
    }
    const trigger = options.restoreFocus ? host.navDrawerTrigger : null;
    const returnFocusTarget =
      options.restoreFocus && trigger?.isConnected && trigger.checkVisibility()
        ? trigger
        : options.restoreFocus
          ? host.querySelector<HTMLElement>(".content")
          : null;
    host
      .querySelector<OpenClawModalDialog>("openclaw-modal-dialog.nav-drawer")
      ?.setReturnFocusTarget(returnFocusTarget ?? null);
    host.navDrawerOpen = false;
    host.navDrawerTrigger = null;
    if (options.restoreFocus) {
      requestAnimationFrame(() => {
        this.restoreFocusTo(trigger instanceof HTMLElement ? trigger : null);
      });
    }
  }

  resizeNavigation(splitRatio: number): void {
    const host = this.host;
    const shell = host.querySelector<HTMLElement>(".shell");
    const context = host.context;
    if (!shell || !context) {
      return;
    }
    const navWidth = Math.round(
      Math.min(NAV_WIDTH_MAX, Math.max(NAV_WIDTH_MIN, splitRatio * shell.clientWidth)),
    );
    context.navigation.update({ navWidth });
  }

  readonly handleNativeToggleSidebar = (): void => {
    this.toggleNavigationSurface();
  };

  readonly handleNativeOpenSearch = (): void => {
    this.openPalette();
  };

  readonly handleNativeToggleSearch = (event: Event): void => {
    // Native menu dispatch falls back to open-only search unless the toggle acknowledges it.
    event.preventDefault();
    this.togglePalette();
  };

  readonly handleNativeNewSession = (): void => {
    const host = this.host;
    const context = host.context;
    if (host.onboardingMode) {
      return;
    }
    if (!context) {
      // Native document-finish can beat runtime initialization; replay the idempotent request.
      host.pendingNativeNewSession = true;
      return;
    }
    if (
      !readSessionMethodAccess(context.gateway.snapshot, {
        method: "sessions.create",
        params: {},
      }).allowed
    ) {
      return;
    }
    host.openNewSession(context.agentSelection.state.selectedId ?? "");
  };

  readonly handleNativeNavigate = (event: Event): void => {
    const detail = (event as CustomEvent<{ path?: unknown; search?: unknown }>).detail;
    const path = detail?.path;
    const schemeCandidate = typeof path === "string" ? path.slice(1) : "";
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /^[a-z][a-z\d+.-]*:/i.test(schemeCandidate)
    ) {
      return;
    }
    const routeId = routeIdFromPath(path);
    if (!routeId || !this.host.context) {
      // Unhandled native routes remain eligible for the host's URL fallback.
      return;
    }
    event.preventDefault();
    // Native callers may request route chrome via a query (e.g. the macOS
    // onboarding handoff lands on /custodian?onboarding=1).
    const search = detail?.search;
    if (typeof search === "string" && search.startsWith("?") && !search.includes("#")) {
      this.host.navigate(routeId, { search });
      return;
    }
    this.host.navigate(routeId);
  };

  readonly handleNativeHistoryState = (event: Event): void => {
    const detail = (event as CustomEvent<NativeHistoryState>).detail;
    if (typeof detail?.canGoBack !== "boolean" || typeof detail.canGoForward !== "boolean") {
      return;
    }
    this.host.nativeHistoryState = detail;
  };

  readonly handleWindowResize = (): void => {
    const host = this.host;
    const mobileNavLayout = isMobileNavLayout();
    // Dismiss the old surface before moving the shared sidebar between breakpoints.
    const dismissedSidebarMenus =
      mobileNavLayout && !host.navDrawerOpen && this.dismissSidebarTransientMenus();
    if (mobileNavLayout) {
      host.desktopNavigationExpanded = false;
    } else if (host.navDrawerOpen) {
      host.closeNavDrawer({ restoreFocus: false });
      // Preserve the stored preference while keeping the responsive handoff expanded.
      host.desktopNavigationExpanded = host.context?.navigation.snapshot.navCollapsed ?? false;
    }
    host.requestUpdate();
    void host.updateComplete.then(() => {
      if (isMobileNavLayout() && !host.navDrawerOpen && dismissedSidebarMenus) {
        requestAnimationFrame(() => {
          this.restoreFocusTo(this.visibleNavDrawerToggle());
        });
      }
    });
  };

  readonly handleUnhandledFileDrag = (event: DragEvent): void => {
    // Bubble phase gives actual drop targets and native file inputs first refusal.
    const nativeFileInput = event
      .composedPath()
      .some(
        (target) =>
          target instanceof HTMLInputElement && target.type === "file" && !target.disabled,
      );
    if (
      event.defaultPrevented ||
      nativeFileInput ||
      !Array.from(event.dataTransfer?.types ?? []).includes("Files")
    ) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "none";
    }
  };

  dismissSidebarTransientMenus(): boolean {
    return (
      this.host.querySelector<AppSidebarElement>("openclaw-app-sidebar")?.dismissTransientMenus() ??
      false
    );
  }

  readonly handleDocumentKeydown = (event: KeyboardEvent): void => {
    const host = this.host;
    if (!host.commandPalette && isCommandPaletteShortcut(event)) {
      event.preventDefault();
      this.togglePalette();
      return;
    }
    if (
      !isSessionRouteId(host.routeState.routeId) &&
      !isOptionalElementDefined(host.terminalPanelElement) &&
      isTerminalPanelShortcut(event)
    ) {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent(TERMINAL_PANEL_TOGGLE_EVENT));
      return;
    }
    if (event.defaultPrevented) {
      return;
    }
    const settingsModifier = event.metaKey !== event.ctrlKey && !event.altKey;
    if (settingsModifier && event.shiftKey && resolveAsciiShortcutKey(event) === "d") {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")
      ) {
        return;
      }
      event.preventDefault();
      window.dispatchEvent(new CustomEvent(DEBUG_OVERLAY_REQUEST_EVENT));
      return;
    }
    const plainKey = !event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey;
    if (plainKey && event.key === "Escape" && this.isSettingsTakeover()) {
      if (host.navDrawerOpen) {
        event.preventDefault();
        host.closeNavDrawer({ restoreFocus: true });
        return;
      }
      if (this.shouldIgnoreSettingsEscape(event)) {
        return;
      }
      event.preventDefault();
      host.exitSettings();
      return;
    }
    if (settingsModifier && event.shiftKey && event.code === "Comma") {
      event.preventDefault();
      host.navigate("appearance");
      return;
    }
    const commandKey = event.metaKey && !event.ctrlKey && !event.altKey;
    if (commandKey && !event.shiftKey && resolveAsciiShortcutKey(event) === "b") {
      event.preventDefault();
      this.toggleNavigationSurface();
    }
  };

  private readonly handleDebugOverlayRequest = (event: Event): void => {
    const host = this.host;
    const descriptor = lazyShellEvent(DEBUG_OVERLAY_REQUEST_EVENT, event);
    if (isOptionalElementDefined(DEBUG_OVERLAY_ELEMENT)) {
      host.querySelector<DebugOverlayElement>(DEBUG_OVERLAY_ELEMENT.tagName)?.toggle();
      this.clearPendingLazyAction(descriptor);
      return;
    }
    this.requestLazyElement(DEBUG_OVERLAY_ELEMENT, descriptor);
  };

  /** Open overlays and editable controls own Escape before settings can exit. */
  shouldIgnoreSettingsEscape(event: KeyboardEvent): boolean {
    const host = this.host;
    const overlaySnapshot = host.context?.overlays.snapshot;
    if (
      host.commandPalette?.isOpen ||
      overlaySnapshot?.devicePairSetupOpen ||
      host.approvalOverlay?.dialogOpen === true ||
      document.querySelector("dialog[open]")
    ) {
      return true;
    }
    const target = event.target;
    return (
      target instanceof Element &&
      target.closest(
        "input, textarea, select, [contenteditable], dialog, [role='dialog'], [role='menu'], [role='listbox']",
      ) !== null
    );
  }

  private readonly handleCommandPaletteOpen = (event: Event, replay?: () => void): void => {
    const host = this.host;
    const palette = host.commandPalette;
    const descriptor = lazyShellEvent(COMMAND_PALETTE_OPEN_EVENT, event);
    if (palette) {
      palette.openPalette();
      this.clearPendingLazyAction(descriptor);
      return;
    }
    this.requestLazyElement(host.commandPaletteElement, descriptor, replay);
  };

  readonly openPalette = (): void => {
    this.handleCommandPaletteOpen(new CustomEvent(COMMAND_PALETTE_OPEN_EVENT), this.openPalette);
  };

  readonly refreshControlUi = (): void => {
    globalThis.location.reload();
  };

  readonly handleShellNavDrawerToggle = (event: Event): void => {
    const trigger = (event as CustomEvent<ShellNavDrawerToggleDetail>).detail?.trigger;
    this.toggleNavigationSurface(trigger instanceof HTMLElement ? trigger : undefined);
  };

  readonly togglePalette = (): void => {
    const palette = this.host.commandPalette;
    if (palette) {
      palette.togglePalette();
    } else {
      this.openPalette();
    }
  };

  readonly openApprovals = (): void => {
    window.dispatchEvent(new CustomEvent(SHELL_APPROVALS_OPEN_EVENT));
  };

  private readonly handleApprovalsOpen = (event: Event): void => {
    const host = this.host;
    const descriptor = lazyShellEvent(SHELL_APPROVALS_OPEN_EVENT, event);
    if (isOptionalElementDefined(host.execApprovalElement)) {
      host.approvalOverlay?.show();
      this.clearPendingLazyAction(descriptor);
      return;
    }
    this.requestLazyElement(host.execApprovalElement, descriptor);
  };

  readonly handleDeferredTerminalToggle = (event: Event): void => {
    const host = this.host;
    if (this.isSessionRoute()) {
      rememberSessionPanelToggle("terminal", event);
      return;
    }
    if (isOptionalElementDefined(host.terminalPanelElement)) {
      return;
    }
    const context = host.context;
    const snapshot = context?.gateway?.snapshot;
    if (
      !snapshot ||
      !isTerminalAvailable(snapshot, context.config.current.terminalEnabled ?? false)
    ) {
      event.preventDefault();
      return;
    }
    this.requestLazyElement(
      host.terminalPanelElement,
      lazyShellEvent(TERMINAL_PANEL_TOGGLE_EVENT, event),
    );
  };

  readonly handleDeferredBrowserToggle = (event: Event): void => {
    const host = this.host;
    if (this.isSessionRoute()) {
      rememberSessionPanelToggle("browser", event);
      return;
    }
    if (isOptionalElementDefined(host.browserPanelElement)) {
      return;
    }
    const snapshot = host.context?.gateway?.snapshot;
    if (snapshot && isBrowserPanelAvailable(snapshot)) {
      this.requestLazyElement(
        host.browserPanelElement,
        lazyShellEvent(BROWSER_PANEL_TOGGLE_EVENT, event),
      );
    } else {
      event.preventDefault();
    }
  };

  readonly handleDeferredDesktopToggle = (event: Event): void => {
    const host = this.host;
    if (this.isSessionRoute()) {
      rememberSessionPanelToggle("desktop", event);
      return;
    }
    const context = host.context;
    if (!context || !isDesktopPanelAvailable(context.gateway.snapshot)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (isOptionalElementDefined(host.desktopPanelElement)) {
      return;
    }
    this.requestLazyElement(
      host.desktopPanelElement,
      lazyShellEvent(DESKTOP_PANEL_TOGGLE_EVENT, event),
    );
  };

  readonly handleDeferredCustodianToggle = (event: Event): void => {
    const host = this.host;
    if (isOptionalElementDefined(host.custodianPanelElement)) {
      return;
    }
    const snapshot = host.context?.gateway?.snapshot;
    if (canCallGatewayMethod(snapshot, "openclaw.chat", "operator.admin")) {
      this.requestLazyElement(
        host.custodianPanelElement,
        lazyShellEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, event),
      );
    } else {
      event.preventDefault();
    }
  };

  restorePendingLazyAction(): void {
    const event = this.pendingLazyAction;
    if (
      event &&
      !this.host.lazyCustomElements.visibleState &&
      this.dispatchLazyShellEvent(event) &&
      !this.host.lazyCustomElements.visibleState
    ) {
      this.clearPendingLazyAction(event);
    }
  }

  private requestLazyElement(
    element: OptionalCustomElement,
    event: LazyShellEvent,
    replay: () => unknown = () => this.dispatchLazyShellEvent(event),
  ): void {
    this.pendingLazyAction = event;
    persistLazyShellAction(event);
    this.host.lazyCustomElements.request(element, () => {
      replay();
      this.clearPendingLazyAction(event);
    });
  }

  private dispatchLazyShellEvent(event: LazyShellEvent): boolean {
    return window.dispatchEvent(
      new CustomEvent(event.eventType, { cancelable: true, detail: event.detail }),
    );
  }

  private clearPendingLazyAction(event: LazyShellEvent): void {
    if (JSON.stringify(this.pendingLazyAction) !== JSON.stringify(event)) {
      return;
    }
    clearLazyShellAction();
    this.pendingLazyAction = null;
  }

  cancelPendingLazyAction(): void {
    const event = this.pendingLazyAction;
    if (event) {
      this.clearPendingLazyAction(event);
    }
  }

  abandonPendingLazyActionForContext(): void {
    this.pendingLazyAction = null;
    clearLazyShellAction();
    this.host.lazyCustomElements.abandon();
  }

  preservePendingLazyActionForReload(): void {
    this.host.lazyCustomElements.abandon();
  }

  readonly handleCommandPaletteSlashCommand = (command: string): void => {
    const host = this.host;
    const chatHandler = host.commandPaletteTarget?.owner.isConnected
      ? host.commandPaletteTarget.onSlashCommand
      : null;
    if (chatHandler) {
      chatHandler(command);
      return;
    }
    // Chat can update its existing draft; other routes hand it through navigation.
    const navigation = host.chatNavigationOptions("chat");
    const search = new URLSearchParams(navigation?.search ?? "");
    search.set("draft", command.endsWith(" ") ? command : `${command} `);
    host.navigate("chat", { ...navigation, search: `?${search.toString()}` });
  };

  readonly handleCommandPaletteTarget = (event: Event): void => {
    const host = this.host;
    const detail = (event as CustomEvent<CommandPaletteTargetDetail>).detail;
    if (!detail || !(detail.owner instanceof Element)) {
      return;
    }
    if (detail.onSlashCommand) {
      host.commandPaletteTarget = detail;
    } else if (host.commandPaletteTarget?.owner === detail.owner) {
      host.commandPaletteTarget = undefined;
    }
    host.requestUpdate();
  };

  /** Native titlebar chrome treats drawer, takeover, and onboarding layouts as collapsed. */
  nativeNavCollapsed(): boolean {
    const host = this.host;
    const mobileNavLayout = isMobileNavLayout();
    return (
      host.onboardingMode ||
      mobileNavLayout ||
      (this.isSettingsTakeover() && !mobileNavLayout) ||
      (!host.navDrawerOpen &&
        !host.desktopNavigationExpanded &&
        (host.context?.navigation.snapshot.navCollapsed ?? false))
    );
  }

  private isSettingsTakeover(): boolean {
    const routeId = this.host.routeState.routeId;
    return routeId !== undefined && isSettingsNavigationRoute(routeId);
  }
}
