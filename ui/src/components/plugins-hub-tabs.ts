// Shared tab strip for the Plugins hub: the plugins, skills, and skill-workshop
// routes render it under one "Plugins" header so the three surfaces read as tabs
// of a single page even though each tab keeps its own route and loader.
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { t } from "../i18n/index.ts";

export type PluginsHubTab = "installed" | "discover" | "skills" | "workshop";

const HUB_TABS: readonly PluginsHubTab[] = ["installed", "discover", "skills", "workshop"];

// Keyboard activation of a cross-route tab unmounts the strip that had focus,
// so the destination strip reclaims focus for its active tab on first render.
// Time-bounded so an aborted navigation cannot steal focus much later.
const PENDING_FOCUS_WINDOW_MS = 2000;
let pendingFocus: { tab: PluginsHubTab; at: number } | null = null;

export type PluginsHubTabsProps = {
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

/**
 * Manual-activation tablist: arrows and Home/End only move focus. Activating
 * a tab can navigate to another route, so activation stays on click/Enter and
 * arrowing must never unmount the strip under the user's focus.
 */
function handleHubTabKeydown(event: KeyboardEvent, tab: PluginsHubTab) {
  const currentIndex = HUB_TABS.indexOf(tab);
  let nextIndex: number;
  switch (event.key) {
    case "ArrowRight":
      nextIndex = (currentIndex + 1) % HUB_TABS.length;
      break;
    case "ArrowLeft":
      nextIndex = (currentIndex - 1 + HUB_TABS.length) % HUB_TABS.length;
      break;
    case "Home":
      nextIndex = 0;
      break;
    case "End":
      nextIndex = HUB_TABS.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  const nextTab = HUB_TABS[nextIndex];
  const tablist = (event.currentTarget as HTMLElement).closest('[role="tablist"]');
  const next = tablist?.querySelector<HTMLElement>(`#plugins-tab-${nextTab}`);
  if (!next) {
    return;
  }
  (event.currentTarget as HTMLElement).tabIndex = -1;
  next.tabIndex = 0;
  next.focus();
}

function selectHubTab(event: MouseEvent, tab: PluginsHubTab, props: PluginsHubTabsProps) {
  // detail === 0 means the click came from the keyboard (Enter/Space); only
  // then should the destination strip pull focus after the route swap. Skip
  // same-tab activation: it does not navigate, and a lingering entry would
  // let a later re-render steal focus from whatever the user moved on to.
  if (event.detail === 0 && tab !== props.active) {
    pendingFocus = { tab, at: Date.now() };
  }
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
  // The ref fires while the strip is still inside lit's template fragment;
  // focus only works once the rendered tree is connected to the document.
  queueMicrotask(() => {
    if (element.isConnected) {
      (element as HTMLElement).focus();
    }
  });
}

/**
 * Every hub page marks its main content container with
 * id="plugins-hub-panel" so aria-controls stays valid on each route.
 */
export function renderPluginsHubTabs(props: PluginsHubTabsProps) {
  return html`
    <div class="plugins-tabs" role="tablist" aria-label=${t("pluginsPage.hubTablistLabel")}>
      ${HUB_TABS.map((tab) => {
        const selected = props.active === tab;
        const count = tab === "installed" ? (props.installedCount ?? null) : null;
        return html`
          <button
            id=${`plugins-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected=${selected ? "true" : "false"}
            aria-controls="plugins-hub-panel"
            .tabIndex=${selected ? 0 : -1}
            class=${selected ? "active" : ""}
            ${selected ? ref((element) => reclaimFocus(tab, element)) : nothing}
            @click=${(event: MouseEvent) => selectHubTab(event, tab, props)}
            @keydown=${(event: KeyboardEvent) => handleHubTabKeydown(event, tab)}
          >
            ${hubTabLabel(tab)} ${count === null ? nothing : html`<span>${count}</span>`}
          </button>
        `;
      })}
    </div>
  `;
}
