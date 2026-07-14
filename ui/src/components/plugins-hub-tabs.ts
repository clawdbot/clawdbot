// Shared tab strip for the Plugins hub: the plugins, skills, and skill-workshop
// routes render it under one "Plugins" header so the three surfaces read as tabs
// of a single page even though each tab keeps its own route and loader.
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { t } from "../i18n/index.ts";
import "./web-awesome-tabs.ts";

export type PluginsHubTab = "installed" | "discover" | "skills" | "workshop";

const HUB_TABS: readonly PluginsHubTab[] = ["installed", "discover", "skills", "workshop"];

// Keyboard activation of a cross-route tab unmounts the strip that had focus,
// so the destination strip reclaims focus for its active tab on first render.
// Time-bounded so an aborted navigation cannot steal focus much later.
const PENDING_FOCUS_WINDOW_MS = 2000;
let pendingFocus: { tab: PluginsHubTab; at: number } | null = null;
let pointerActivation = false;

type PluginsHubTabsProps = {
  active: PluginsHubTab;
  /** Installed-plugin count badge; omit on pages without catalog data. */
  installedCount?: number | null;
  onSelect: (tab: PluginsHubTab) => void;
};

function hubTabLabel(tab: PluginsHubTab): string {
  switch (tab) {
    case "installed":
      return t("pluginsPage.installedTab");
    case "discover":
      return t("pluginsPage.discoverTab");
    case "skills":
      return t("tabs.skills");
    case "workshop":
      return t("pluginsPage.workshopTab");
    default:
      return tab satisfies never;
  }
}

function selectHubTab(tab: PluginsHubTab, props: PluginsHubTabsProps) {
  // Keyboard activation unmounts the focused strip; only then should the
  // destination strip pull focus after the route swap. Skip
  // same-tab activation: it does not navigate, and a lingering entry would
  // let a later re-render steal focus from whatever the user moved on to.
  if (!pointerActivation && tab !== props.active) {
    pendingFocus = { tab, at: Date.now() };
  }
  pointerActivation = false;
  props.onSelect(tab);
}

function reclaimFocus(tab: PluginsHubTab, element: Element | undefined) {
  if (!element || pendingFocus?.tab !== tab) {
    return;
  }
  const pending = pendingFocus;
  pendingFocus = null;
  if (Date.now() - pending.at > PENDING_FOCUS_WINDOW_MS) {
    return;
  }
  // The ref fires while the strip is still inside lit's template fragment.
  // A task lets both Lit and Web Awesome finish connecting before focus moves.
  window.setTimeout(() => {
    if (element.isConnected) {
      (element as HTMLElement).focus();
    }
  }, 0);
}

/**
 * Every hub page marks its main content container with
 * id="plugins-hub-panel" so aria-controls stays valid on each route.
 * Styled through the settings design language's segmented control
 * (ui/src/styles/settings.css) while keeping tablist semantics.
 */
export function renderPluginsHubTabs(props: PluginsHubTabsProps) {
  return html`
    <wa-tab-group
      class="settings-segmented plugins-hub-tabs plugins-tabs"
      aria-label=${t("pluginsPage.hubTablistLabel")}
      .active=${props.active}
      activation="manual"
      without-scroll-controls
      @wa-tab-show=${(event: CustomEvent<{ name: PluginsHubTab }>) =>
        selectHubTab(event.detail.name, props)}
    >
      ${HUB_TABS.map((tab) => {
        const selected = props.active === tab;
        const count = tab === "installed" ? (props.installedCount ?? null) : null;
        return html`
          <wa-tab
            id=${`plugins-tab-${tab}`}
            panel=${tab}
            aria-controls="plugins-hub-panel"
            class="settings-segmented__btn ${selected ? "settings-segmented__btn--active" : ""}"
            ?active=${selected}
            @click=${(event: MouseEvent) => {
              // Trusted pointer clicks carry a click count. Keyboard and AT
              // synthesized clicks use detail=0 and need focus recovery.
              pointerActivation = event.detail > 0;
            }}
            @keydown=${() => {
              // Any keyboard interaction supersedes a prior pointer click.
              // This also clears clicks on the already-active tab, which do
              // not emit wa-tab-show and would otherwise leave stale state.
              pointerActivation = false;
            }}
            ${selected ? ref((element) => reclaimFocus(tab, element)) : nothing}
          >
            ${hubTabLabel(tab)}
            ${count === null ? nothing : html`<span class="settings-count">${count}</span>`}
          </wa-tab>
        `;
      })}
    </wa-tab-group>
  `;
}
