import { html, nothing } from "lit";
import type { ApplicationContext } from "./context.ts";

export function navigationSurfaceIsHidden(params: {
  navCollapsed: boolean;
  navDrawerOpen: boolean;
  mobileNavLayout: boolean;
}): boolean {
  return params.mobileNavLayout ? !params.navDrawerOpen : params.navCollapsed;
}

export function renderFloatingUpdateCard(params: {
  navigationSurfaceHidden: boolean;
  onboarding: boolean;
  updateAvailable: ApplicationContext["overlays"]["snapshot"]["updateAvailable"];
  updateRunning: boolean;
  onUpdate: () => void;
}) {
  if (!params.navigationSurfaceHidden || params.onboarding) {
    return nothing;
  }
  return html`<openclaw-sidebar-update-card
    class="sidebar-update-card--floating"
    .updateAvailable=${params.updateAvailable}
    .updateRunning=${params.updateRunning}
    .onUpdate=${params.onUpdate}
  ></openclaw-sidebar-update-card>`;
}
