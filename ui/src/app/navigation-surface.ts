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
  onRefresh: () => void;
  onHoldUpdate?: () => Promise<boolean>;
  onReviewUpdate?: () => void;
  onNavigate?: (routeId: NavigationRouteId) => void;
  onOpenApprovals?: () => void;
}) {
  // A stale client must always have a visible refresh action, including during
  // onboarding, even though update-available actions stay hidden there.
  // Mobile keeps attention in its drawer; desktop collapse has no drawer, so
  // it still needs the floating copy while navigation is hidden.
  const desktopNavigationHidden = params.navigationSurfaceHidden && !params.mobileNavLayout;
  const showAttention = desktopNavigationHidden && !params.onboarding && !params.compact;
  const showUpdateCard =
    !params.compact &&
    (params.refreshRequired || (!params.onboarding && params.navigationSurfaceHidden));
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
