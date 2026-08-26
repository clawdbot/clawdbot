import { html, nothing } from "lit";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationContext } from "./context.ts";
import type { UpdateProgress } from "./update-confirmation.ts";

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
  settingsTakeover?: boolean;
  compact?: boolean;
}): boolean {
  // Mobile keeps attention in its drawer except during onboarding. Settings
  // replaces that drawer/sidebar entirely, so both need the floating copy.
  const attentionNeedsFloating =
    params.settingsTakeover ||
    (params.navigationSurfaceHidden && (!params.mobileNavLayout || params.onboarding));
  return attentionNeedsFloating && !params.compact;
}

export function renderFloatingUpdateCard(params: {
  navigationSurfaceHidden: boolean;
  mobileNavLayout: boolean;
  onboarding: boolean;
  settingsTakeover?: boolean;
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
  onRefresh: () => void;
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
  return html`${showAttention
    ? html`<openclaw-sidebar-attention
        class="sidebar-attention--floating"
        .onNavigate=${params.onNavigate}
        .onOpenApprovals=${params.onOpenApprovals}
      ></openclaw-sidebar-attention>`
    : nothing}${showUpdateCard
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
    : nothing}`;
}
