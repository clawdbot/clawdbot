import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import "../styles/hub-tabs.css";
import "./web-awesome-tabs.ts";

export type HubTabOption<T extends string> = {
  value: T;
  label: unknown;
  badge?: unknown;
};

type HubTabsProps<T extends string> = {
  id: string;
  active: T;
  tabs: ReadonlyArray<HubTabOption<T>>;
  ariaLabel: string;
  panelId: string;
  className?: string;
  onSelect: (tab: T) => void;
};

// Keyboard activation unmounts a route-owned strip, so the destination strip
// reclaims focus on first render. The timeout prevents an aborted navigation
// from stealing focus later.
const PENDING_FOCUS_WINDOW_MS = 2000;
let pendingFocus: { hubId: string; tab: string; at: number } | null = null;
let pointerActivation: { hubId: string; tab: string } | null = null;

function selectHubTab<T extends string>(tab: T, props: HubTabsProps<T>) {
  const activatedByPointer = pointerActivation?.hubId === props.id && pointerActivation.tab === tab;
  pointerActivation = null;
  if (!activatedByPointer && tab !== props.active) {
    pendingFocus = { hubId: props.id, tab, at: Date.now() };
  }
  props.onSelect(tab);
}

function reclaimFocus(hubId: string, tab: string, element: Element | undefined) {
  if (!element || pendingFocus?.hubId !== hubId || pendingFocus.tab !== tab) {
    return;
  }
  const pending = pendingFocus;
  pendingFocus = null;
  if (Date.now() - pending.at > PENDING_FOCUS_WINDOW_MS) {
    return;
  }
  // The ref fires while the strip is still inside Lit's template fragment.
  // A task lets both Lit and Web Awesome finish connecting before focus moves.
  window.setTimeout(() => {
    if (element.isConnected) {
      (element as HTMLElement).focus();
    }
  }, 0);
}

export function renderHubTabs<T extends string>(props: HubTabsProps<T>): TemplateResult {
  const className = `hub-tabs ${props.id}-hub-tabs${props.className ? ` ${props.className}` : ""}`;
  return html`
    <wa-tab-group
      class=${className}
      aria-label=${props.ariaLabel}
      .active=${props.active}
      activation="manual"
      without-scroll-controls
      @wa-tab-show=${(event: CustomEvent<{ name: T }>) => selectHubTab(event.detail.name, props)}
    >
      ${props.tabs.map((tab) => {
        const selected = props.active === tab.value;
        return html`
          <wa-tab
            id=${`${props.id}-tab-${tab.value}`}
            panel=${tab.value}
            aria-controls=${props.panelId}
            class="hub-tab"
            ?active=${selected}
            @click=${(event: MouseEvent) => {
              pointerActivation = event.detail > 0 ? { hubId: props.id, tab: tab.value } : null;
            }}
            @keydown=${() => {
              pointerActivation = null;
            }}
            ${selected ? ref((element) => reclaimFocus(props.id, tab.value, element)) : nothing}
          >
            ${tab.label}${tab.badge ?? nothing}
          </wa-tab>
        `;
      })}
    </wa-tab-group>
  `;
}
