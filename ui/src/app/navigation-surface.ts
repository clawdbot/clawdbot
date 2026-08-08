import { html, nothing } from "lit";
import type { ApplicationContext } from "./context.ts";

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
  onboarding: boolean;
  updateAvailable: ApplicationContext["overlays"]["snapshot"]["updateAvailable"];
  updateRunning: boolean;
  onUpdate: () => void;
  refreshRequired: boolean;
  onRefresh: () => void;
}) {
  // A stale client must always have a visible refresh action, including during
  // onboarding, even though update-available actions stay hidden there.
  if (params.onboarding ? !params.refreshRequired : !params.navigationSurfaceHidden) {
    return nothing;
  }
  return html`<openclaw-sidebar-update-card
    class="sidebar-update-card--floating"
    .updateAvailable=${params.updateAvailable}
    .updateRunning=${params.updateRunning}
    .onUpdate=${params.onUpdate}
    .refreshRequired=${params.refreshRequired}
    .onRefresh=${params.onRefresh}
  ></openclaw-sidebar-update-card>`;
}
