import { isSettingsNavigationRoute } from "../app-navigation.ts";
import { isSessionRouteId, routeIdFromPath, type RouteId } from "../app-route-paths.ts";
import {
  applyCommandPaletteTargetEvent,
  COMMAND_PALETTE_OPEN_EVENT,
  COMMAND_PALETTE_TARGET_EVENT,
  isCommandPaletteShortcut,
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  shellNavDrawerTriggerFromEvent,
  type CommandPaletteElement,
  type CommandPaletteTargetDetail,
} from "../components/command-palette-contract.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  DEBUG_OVERLAY_REQUEST_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  isTerminalPanelShortcut,
  KEYBOARD_SHORTCUTS_REQUEST_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import { rememberSessionPanelToggle } from "../components/session-panel-toggle-buffer.ts";
import type { BoardFace } from "../lib/board/settings.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { isTerminalAvailable } from "../lib/terminal-availability.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "./context.ts";
import {
  DEBUG_OVERLAY_ELEMENT,
  isOptionalElementDefined,
  KEYBOARD_SHORTCUTS_ELEMENT,
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
import { NavDrawerSwipeLoader } from "./nav-drawer-swipe-loader.ts";
import {
  dismissNavigationTransientSurfaces,
  handleNavDrawerKeydown,
  moveToastToNavDrawer,
  restoreToastFromNavDrawer,
  visibleNavDrawerToggle,
} from "./navigation-surface.ts";
import { isBrowserPanelAvailable, isDesktopPanelAvailable } from "./panel-availability.ts";
import { NAV_WIDTH_MAX, NAV_WIDTH_MIN } from "./settings.ts";
import { retryStaleChunkReloadWhenReachable } from "./stale-chunk-reload.ts";

type DebugOverlayElement = HTMLElement & {
  toggle: () => void;
};

type KeyboardShortcutsDialogElement = HTMLElement & {
  isOpen: boolean;
  toggle: () => void;
};

function isSettingsTakeover(routeId: RouteId | undefined): boolean {
  return routeId !== undefined && isSettingsNavigationRoute(routeId);
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
  private listeners: AbortController | undefined;
  private readonly navDrawerSwipe: NavDrawerSwipeLoader;
  constructor(private readonly host: ShellChromeHost) {
    this.navDrawerSwipe = new NavDrawerSwipeLoader(host, () => this.toggleNavigationSurface());
  }

  private isSessionRoute(): boolean {
    const locationRouteId = routeIdFromPath(
      globalThis.location?.pathname ?? "",
      this.host.context?.basePath ?? "",
    );
    return isSessionRouteId(locationRouteId ?? this.host.routeState.routeId);
  }

  connect(): void {
    this.disconnect();
    this.listeners = new AbortController();
    // One connection owns all three targets; abort removes exactly its listeners.
    const options = { signal: this.listeners.signal };
    const host = this.host;
    host.nativeHistoryState = readNativeHistoryState();
    host.addEventListener(COMMAND_PALETTE_TARGET_EVENT, this.handleCommandPaletteTarget, options);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, this.handleCommandPaletteOpen, options);
    window.addEventListener(
      SHELL_NAV_DRAWER_TOGGLE_EVENT,
      this.handleShellNavDrawerToggle,
      options,
    );
    window.addEventListener(DEBUG_OVERLAY_REQUEST_EVENT, this.handleDebugOverlayRequest, options);
    window.addEventListener(
      KEYBOARD_SHORTCUTS_REQUEST_EVENT,
      this.handleKeyboardShortcutsRequest,
      options,
    );
    document.addEventListener("keydown", this.handleDocumentKeydown, {
      capture: true,
      signal: this.listeners.signal,
    });
    document.addEventListener("keydown", this.handleDocumentKeydownBubble, options);
    window.addEventListener("resize", this.handleWindowResize, options);
    window.addEventListener("dragover", this.handleUnhandledFileDrag, options);
    window.addEventListener("drop", this.handleUnhandledFileDrag, options);
    window.addEventListener(NATIVE_HISTORY_STATE_EVENT, this.handleNativeHistoryState, options);
    // Shipped Mac hosts use these same events even when native web chrome is absent.
    window.addEventListener(
      "openclaw:native-toggle-sidebar",
      this.handleNativeToggleSidebar,
      options,
    );
    window.addEventListener("openclaw:native-open-search", this.handleNativeOpenSearch, options);
    window.addEventListener(
      "openclaw:native-toggle-search",
      this.handleNativeToggleSearch,
      options,
    );
    window.addEventListener("openclaw:native-new-session", this.handleNativeNewSession, options);
    window.addEventListener("openclaw:native-navigate", this.handleNativeNavigate, options);
    window.addEventListener(
      TERMINAL_PANEL_TOGGLE_EVENT,
      this.handleDeferredTerminalToggle,
      options,
    );
    window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, this.handleDeferredBrowserToggle, options);
    window.addEventListener(DESKTOP_PANEL_TOGGLE_EVENT, this.handleDeferredDesktopToggle, options);
    window.addEventListener(
      CUSTODIAN_PANEL_TOGGLE_EVENT,
      this.handleDeferredCustodianToggle,
      options,
    );
    window.addEventListener(SHELL_APPROVALS_OPEN_EVENT, this.handleApprovalsOpen, options);
    this.navDrawerSwipe.connect();
    if (isMobileNavLayout()) {
      this.navDrawerSwipe.load();
    }
  }

  disconnect(): void {
    this.listeners?.abort();
    this.listeners = undefined;
    this.navDrawerSwipe.disconnect();
  }

  toggleNavigationSurface(trigger?: HTMLElement): void {
    const host = this.host;
    const context = host.context;
    // Desktop settings takeover has no app nav; its mobile drawer still owns navigation.
    if (
      !context ||
      host.onboardingMode ||
      (isSettingsTakeover(host.routeState.routeId) && !isMobileNavLayout())
    ) {
      return;
    }
    if (isMobileNavLayout()) {
      this.navDrawerSwipe.load();
      if (host.navDrawerOpen) {
        host.closeNavDrawer({ restoreFocus: true });
        return;
      }
      host.navDrawerTrigger = trigger ?? visibleNavDrawerToggle(host) ?? null;
      host.navDrawerOpen = true;
      moveToastToNavDrawer(host);
      if (!this.navDrawerSwipe.opened()) {
        void host.updateComplete.then(() => {
          if (host.isConnected && host.navDrawerOpen) {
            host.querySelector<HTMLElement>(".shell-nav")?.focus({ preventScroll: true });
          }
        });
      }
      return;
    }
    // A responsive handoff expands this shell without overwriting the desktop preference.
    const nextNavCollapsed =
      host.navDrawerOpen ||
      !(context.navigation.snapshot.navCollapsed && !host.desktopNavigationExpanded);
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
    }
  }

  /** Native Mac chrome hides in-page toggles, so restoration falls back to content. */
  restoreFocusTo = (target: HTMLElement | null | undefined): void =>
    (target?.isConnected && target.checkVisibility()
      ? target
      : this.host.querySelector<HTMLElement>(".content")
    )?.focus();

  closeNavDrawer(options: { restoreFocus?: boolean } = {}): void {
    const host = this.host;
    if (host.navDrawerOpen) {
      this.dismissSidebarTransientMenus();
      this.navDrawerSwipe.closed();
    }
    restoreToastFromNavDrawer(host);
    const trigger = options.restoreFocus ? host.navDrawerTrigger : null;
    host.navDrawerOpen = false;
    host.navDrawerTrigger = null;
    if (options.restoreFocus) {
      requestAnimationFrame(() => this.restoreFocusTo(trigger));
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

  readonly handleNativeToggleSidebar = (): void => this.toggleNavigationSurface();
  readonly handleNativeOpenSearch = (): void => this.openPalette();

  readonly handleNativeToggleSearch = (event: Event): void => {
    event.preventDefault(); // Acknowledges toggle so native does not fall back to open-only search.
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
      this.navDrawerSwipe.load();
      host.desktopNavigationExpanded = false;
    } else if (host.navDrawerOpen) {
      host.closeNavDrawer({ restoreFocus: false });
      // Preserve the tab-local state while keeping the responsive handoff expanded.
      host.desktopNavigationExpanded = host.context?.navigation.snapshot.navCollapsed ?? false;
    }
    host.requestUpdate();
    void host.updateComplete.then(() => {
      if (isMobileNavLayout() && !host.navDrawerOpen && dismissedSidebarMenus) {
        requestAnimationFrame(() => {
          this.restoreFocusTo(visibleNavDrawerToggle(host));
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

  dismissSidebarTransientMenus = (): boolean => dismissNavigationTransientSurfaces(this.host);

  private readonly handleDocumentKeydownBubble = (event: KeyboardEvent): void => {
    const host = this.host;
    if (event.defaultPrevented || !matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.escape, event)) {
      return;
    }
    if (host.navDrawerOpen && isMobileNavLayout() && !document.openClawModalLayers?.size) {
      event.preventDefault();
      host.closeNavDrawer({ restoreFocus: true });
    } else if (
      isSettingsTakeover(host.routeState.routeId) &&
      !this.shouldIgnoreSettingsEscape(event)
    ) {
      event.preventDefault();
      host.exitSettings();
    }
  };

  readonly handleDocumentKeydown = (event: KeyboardEvent): void => {
    const host = this.host;
    if (document.openClawModalLayers?.size) {
      return;
    }
    if (host.navDrawerOpen && isMobileNavLayout()) {
      handleNavDrawerKeydown(host, event);
      return;
    }
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
    if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.keyboardShortcuts, event)) {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent(KEYBOARD_SHORTCUTS_REQUEST_EVENT));
      return;
    }
    if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.debugOverlay, event)) {
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
    if (
      matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.escape, event) &&
      isSettingsTakeover(host.routeState.routeId)
    ) {
      if (host.navDrawerOpen) {
        event.preventDefault();
        host.closeNavDrawer({ restoreFocus: true });
        return;
      }
      if (event.eventPhase === Event.CAPTURING_PHASE || this.shouldIgnoreSettingsEscape(event)) {
        return;
      }
      event.preventDefault();
      host.exitSettings();
      return;
    }
    if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.appearanceSettings, event)) {
      event.preventDefault();
      host.navigate("appearance");
      return;
    }
    if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.toggleSidebar, event)) {
      event.preventDefault();
      this.toggleNavigationSurface();
    }
  };

  private readonly handleDebugOverlayRequest = (event: Event): void => {
    const host = this.host;
    if (host.navDrawerOpen && isMobileNavLayout()) {
      host.closeNavDrawer({ restoreFocus: false });
    }
    const descriptor = lazyShellEvent(DEBUG_OVERLAY_REQUEST_EVENT, event);
    if (isOptionalElementDefined(DEBUG_OVERLAY_ELEMENT)) {
      host.querySelector<DebugOverlayElement>(DEBUG_OVERLAY_ELEMENT.tagName)?.toggle();
      this.clearPendingLazyAction(descriptor);
      return;
    }
    this.requestLazyElement(DEBUG_OVERLAY_ELEMENT, descriptor);
  };

  private readonly handleKeyboardShortcutsRequest = (event: Event): void => {
    const descriptor = lazyShellEvent(KEYBOARD_SHORTCUTS_REQUEST_EVENT, event);
    if (isOptionalElementDefined(KEYBOARD_SHORTCUTS_ELEMENT)) {
      this.host
        .querySelector<KeyboardShortcutsDialogElement>(KEYBOARD_SHORTCUTS_ELEMENT.tagName)
        ?.toggle();
      this.clearPendingLazyAction(descriptor);
      return;
    }
    this.requestLazyElement(KEYBOARD_SHORTCUTS_ELEMENT, descriptor);
  };

  // Open controls own Escape. Slotted options hide their listbox in shadow DOM,
  // so recognize the open select host before Settings can consume the key.
  shouldIgnoreSettingsEscape(event: KeyboardEvent): boolean {
    const host = this.host;
    const overlaySnapshot = host.context?.overlays.snapshot;
    if (
      host.commandPalette?.isOpen ||
      host.querySelector<KeyboardShortcutsDialogElement>(KEYBOARD_SHORTCUTS_ELEMENT.tagName)
        ?.isOpen ||
      overlaySnapshot?.devicePairSetupOpen ||
      host.approvalOverlay?.dialogOpen === true ||
      document.openClawModalLayers?.size
    ) {
      return true;
    }
    const target = event.target;
    return (
      target instanceof Element &&
      target.closest(
        "input, textarea, select, wa-select[open], [contenteditable], dialog, [role='dialog'], [role='menu'], [role='listbox']",
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

  readonly openPalette = (): void =>
    this.handleCommandPaletteOpen(new CustomEvent(COMMAND_PALETTE_OPEN_EVENT), this.openPalette);

  readonly refreshControlUi = (): void => globalThis.location.reload();
  readonly handleShellNavDrawerToggle = (event: Event): void => {
    this.toggleNavigationSurface(shellNavDrawerTriggerFromEvent(event));
  };

  readonly togglePalette = (): void => {
    const palette = this.host.commandPalette;
    if (palette) {
      palette.togglePalette();
    } else {
      this.openPalette();
    }
  };

  readonly openApprovals = (): void =>
    void window.dispatchEvent(new CustomEvent(SHELL_APPROVALS_OPEN_EVENT));

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

  private lazyElementForShellEvent(eventType: LazyShellEvent["eventType"]): OptionalCustomElement {
    const host = this.host;
    const elements: Record<LazyShellEvent["eventType"], OptionalCustomElement> = {
      [COMMAND_PALETTE_OPEN_EVENT]: host.commandPaletteElement,
      [DEBUG_OVERLAY_REQUEST_EVENT]: DEBUG_OVERLAY_ELEMENT,
      [KEYBOARD_SHORTCUTS_REQUEST_EVENT]: KEYBOARD_SHORTCUTS_ELEMENT,
      [TERMINAL_PANEL_TOGGLE_EVENT]: host.terminalPanelElement,
      [BROWSER_PANEL_TOGGLE_EVENT]: host.browserPanelElement,
      [DESKTOP_PANEL_TOGGLE_EVENT]: host.desktopPanelElement,
      [CUSTODIAN_PANEL_TOGGLE_EVENT]: host.custodianPanelElement,
      [SHELL_APPROVALS_OPEN_EVENT]: host.execApprovalElement,
    };
    return elements[eventType];
  }

  restorePendingLazyAction(): void {
    const event = this.pendingLazyAction;
    if (!event || this.host.lazyCustomElements.visibleState) {
      return;
    }
    const element = this.lazyElementForShellEvent(event.eventType);
    if (isOptionalElementDefined(element) && !this.host.querySelector(element.tagName)) {
      // Loaded but render-gated (e.g. the shell is still booting): nothing can
      // consume the dispatch yet, and re-dispatching re-arms a request/update
      // cycle whose microtasks starve the boot (Gateway socket included).
      // The host retries after every completed update, so the replay fires on
      // the update that first renders the element.
      return;
    }
    if (this.dispatchLazyShellEvent(event) && !this.host.lazyCustomElements.visibleState) {
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

  retryPendingLazyAction(canReload: () => boolean): Promise<boolean> {
    const event = this.pendingLazyAction;
    // Render-owned surfaces need recovery too, but have no user action to persist for replay.
    return retryStaleChunkReloadWhenReachable({
      canReload: () =>
        canReload() &&
        this.pendingLazyAction === event &&
        (!event || persistLazyShellAction(event)),
    });
  }

  private dispatchLazyShellEvent({ eventType, detail }: LazyShellEvent): boolean {
    return window.dispatchEvent(new CustomEvent(eventType, { cancelable: true, detail }));
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

  readonly handleCommandPaletteTarget = (event: Event): void =>
    applyCommandPaletteTargetEvent(this.host, event);

  nativeNavCollapsed(): boolean {
    const host = this.host;
    const mobileNavLayout = isMobileNavLayout();
    return (
      host.onboardingMode ||
      mobileNavLayout ||
      (isSettingsTakeover(host.routeState.routeId) && !mobileNavLayout) ||
      (!host.navDrawerOpen &&
        !host.desktopNavigationExpanded &&
        (host.context?.navigation.snapshot.navCollapsed ?? false))
    );
  }
}
