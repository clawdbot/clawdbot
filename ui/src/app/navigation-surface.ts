import { html, nothing } from "lit";
import type { NavigationRouteId } from "../app-navigation.ts";
import { isCommandPaletteShortcut } from "../components/command-palette-contract.ts";
import { isTerminalPanelShortcut } from "../components/panel-toggle-contract.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import type { ApplicationContext } from "./context.ts";
import type { UpdateProgress } from "./update-confirmation.ts";

const NAV_DRAWER_FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

type AppSidebarElement = HTMLElement & { dismissTransientMenus(): boolean };
type SidebarAttentionElement = HTMLElement & { dismissPanel(): boolean };

export function dismissNavigationTransientSurfaces(host: HTMLElement): boolean {
  // Unupgraded elements cannot own transient UI; navigation must not wait for their imports.
  const dismissedPanel = [
    ...host.querySelectorAll<SidebarAttentionElement>("openclaw-sidebar-attention:defined"),
  ]
    .map((attention) => attention.dismissPanel())
    .some((dismissed) => dismissed);
  const dismissedMenu = host
    .querySelector<AppSidebarElement>("openclaw-app-sidebar:defined")
    ?.dismissTransientMenus();
  return dismissedMenu === true || dismissedPanel;
}

function trapNavDrawerFocus(host: HTMLElement, event: KeyboardEvent): void {
  const drawer = host.querySelector<HTMLElement>(".shell-nav");
  if (!drawer) {
    return;
  }
  if (
    event
      .composedPath()
      .some(
        (target) =>
          target instanceof Element &&
          target !== drawer &&
          target.matches("dialog, [role='dialog']"),
      )
  ) {
    return;
  }
  const focusable = [...drawer.querySelectorAll<HTMLElement>(NAV_DRAWER_FOCUSABLE_SELECTOR)].filter(
    (candidate) => candidate.checkVisibility(),
  );
  const target = event.shiftKey ? focusable.at(-1) : focusable[0];
  const boundary = event.shiftKey ? focusable[0] : focusable.at(-1);
  if (
    !drawer.contains(document.activeElement) ||
    document.activeElement === boundary ||
    (event.shiftKey && document.activeElement === drawer)
  ) {
    event.preventDefault();
    (target ?? drawer).focus({ preventScroll: true });
  }
}

export function handleNavDrawerKeydown(
  host: HTMLElement & { closeNavDrawer(options?: { restoreFocus?: boolean }): void },
  event: KeyboardEvent,
): void {
  if (event.defaultPrevented) {
    return;
  }
  if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.escape, event)) {
    return;
  }
  if (matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.toggleSidebar, event)) {
    event.preventDefault();
    host.closeNavDrawer({ restoreFocus: true });
  } else if (event.key === "Tab") {
    trapNavDrawerFocus(host, event);
  } else if (
    isCommandPaletteShortcut(event) ||
    isTerminalPanelShortcut(event) ||
    matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.workspaceFiles, event) ||
    matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.sideChat, event)
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

export function moveToastToNavDrawer(host: HTMLElement): void {
  const drawer = host.querySelector<HTMLElement>(".shell-nav");
  const toastHost = host.querySelector<HTMLElement>("openclaw-toast-host");
  if (drawer && toastHost && toastHost.parentElement !== drawer) {
    drawer.moveBefore(toastHost, null);
  }
}

export function restoreToastFromNavDrawer(host: HTMLElement): void {
  const shell = host.querySelector<HTMLElement>(".shell");
  const toastHost = host.querySelector<HTMLElement>("openclaw-toast-host");
  if (shell && toastHost?.parentElement?.classList.contains("shell-nav")) {
    shell.moveBefore(toastHost, null);
  }
}

export function visibleNavDrawerToggle(host: HTMLElement): HTMLElement | undefined {
  return [...host.querySelectorAll<HTMLElement>(".topbar-nav-toggle, .chat-pane__nav-toggle")].find(
    (candidate) => candidate.checkVisibility(),
  );
}

export function navigationSurfaceIsHidden(params: {
  onboarding: boolean;
  navCollapsed: boolean;
  navDrawerOpen: boolean;
  mobileNavLayout: boolean;
}): boolean {
  return (
    params.onboarding || (params.mobileNavLayout ? !params.navDrawerOpen : params.navCollapsed)
  );
}

export function floatingSidebarAttentionVisible(params: {
  navigationSurfaceHidden: boolean;
  mobileNavLayout: boolean;
  onboarding: boolean;
  compact?: boolean;
}): boolean {
  const attentionNeedsFloating =
    params.navigationSurfaceHidden && !params.mobileNavLayout && !params.onboarding;
  return attentionNeedsFloating && !params.compact;
}

export function renderFloatingUpdateCard(params: {
  navigationSurfaceHidden: boolean;
  mobileNavLayout: boolean;
  onboarding: boolean;
  compact?: boolean;
  updateAvailable: ApplicationContext["overlays"]["snapshot"]["updateAvailable"];
  updateSchedule?: ApplicationContext["overlays"]["snapshot"]["updateSchedule"];
  heldUpdateCampaignId?: string | null;
  updateBusy: boolean;
  statusBanner?: ApplicationContext["overlays"]["snapshot"]["updateStatusBanner"];
  watchUpdateProgress?: (listener: (progress: UpdateProgress) => void) => () => void;
  canUpdate?: boolean;
  canHoldUpdate?: boolean;
  onUpdate: () => void;
  refreshRequired: boolean;
  onRefresh: () => Promise<boolean>;
  onHoldUpdate?: () => Promise<boolean>;
  onReviewUpdate?: () => void;
  onNavigate?: (routeId: NavigationRouteId) => void;
  onOpenApprovals?: () => void;
}) {
  const showAttention = floatingSidebarAttentionVisible(params);
  const showUpdateCard = !params.compact && params.refreshRequired;
  if (!showAttention && !showUpdateCard) {
    return nothing;
  }
  return html`${
    showAttention
      ? html`<openclaw-sidebar-attention
          class="sidebar-attention--floating"
          .onNavigate=${params.onNavigate}
          .onOpenApprovals=${params.onOpenApprovals}
        ></openclaw-sidebar-attention>`
      : nothing
  }${
    showUpdateCard
      ? html`<openclaw-sidebar-update-card
          class="sidebar-update-card--floating"
          .updateAvailable=${params.updateAvailable}
          .updateSchedule=${params.updateSchedule ?? null}
          .heldUpdateCampaignId=${params.heldUpdateCampaignId ?? null}
          .updateBusy=${params.updateBusy}
          .statusBanner=${params.statusBanner ?? null}
          .watchUpdateProgress=${params.watchUpdateProgress}
          .canUpdate=${params.canUpdate ?? false}
          .canHoldUpdate=${params.canHoldUpdate ?? false}
          .onUpdate=${params.onUpdate}
          .refreshRequired=${params.refreshRequired}
          .onRefresh=${params.onRefresh}
          .onHoldUpdate=${params.onHoldUpdate ?? (async () => false)}
          .onReviewUpdate=${params.onReviewUpdate ?? (() => undefined)}
        ></openclaw-sidebar-update-card>`
      : nothing
  }`;
}
