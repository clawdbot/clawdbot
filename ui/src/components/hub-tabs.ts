import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import "../styles/hub-tabs.css";
import { syncTabGroupLabel } from "./web-awesome-tabs.ts";

export type HubTabOption<T extends string> = {
  value: T;
  label: unknown;
  badge?: unknown;
  count?: number | null;
  disabled?: boolean;
  testId?: string;
};

type HubTabsProps<T extends string> = {
  id: string;
  active: T | null;
  tabs: ReadonlyArray<HubTabOption<T>>;
  ariaLabel: string;
  panelId: string;
  className?: string;
  /** Opts this strip into Carapace's segmented-control presentation. */
  carapace?: boolean;
  variant?: "primary" | "sub";
  onSelect: (tab: T) => void;
  onActivate?: (element: HTMLElement) => void;
};

// Keyboard activation unmounts a route-owned strip, so the destination strip
// reclaims focus on first render. The timeout prevents an aborted navigation
// from stealing focus later.
const PENDING_FOCUS_WINDOW_MS = 2000;
// Web Awesome selects its first tab when `active` is empty. A truthy value that
// matches no panel preserves an intentional no-selection state.
const NO_ACTIVE_TAB = "__openclaw-hub-tabs-no-active__";
let pendingFocus: { hubId: string; tab: string; at: number; source: Element } | null = null;

function reclaimFocus(hubId: string, tab: string, element: Element | undefined) {
  if (!element || pendingFocus?.hubId !== hubId || pendingFocus.tab !== tab) {
    return;
  }
  const pending = pendingFocus;
  if (Date.now() - pending.at > PENDING_FOCUS_WINDOW_MS) {
    pendingFocus = null;
    return;
  }
  // The ref fires while the strip is still inside Lit's template fragment.
  // A task lets both Lit and Web Awesome finish connecting before focus moves.
  window.setTimeout(() => {
    if (pendingFocus !== pending) {
      return;
    }
    pendingFocus = null;
    const currentFocus = document.activeElement;
    if (
      element.isConnected &&
      Date.now() - pending.at <= PENDING_FOCUS_WINDOW_MS &&
      (currentFocus === pending.source ||
        currentFocus === document.body ||
        currentFocus === document.documentElement)
    ) {
      (element as HTMLElement).focus();
    }
  }, 0);
}

export function renderHubTabs<T extends string>(props: HubTabsProps<T>): TemplateResult {
  const variant = props.variant ?? "primary";
  const className = `hub-tabs hub-tabs--${variant} ${props.id}-hub-tabs${props.carapace ? " oc-segmented" : ""}${props.className ? ` ${props.className}` : ""}`;
  const fallbackFocusValue =
    props.active === null ? props.tabs.find((tab) => !tab.disabled)?.value : null;
  return html`
    <wa-tab-group
      class=${className}
      aria-label=${props.ariaLabel}
      .active=${props.active ?? NO_ACTIVE_TAB}
      activation="manual"
      without-scroll-controls
      ${ref((element) => syncTabGroupLabel(element, props.ariaLabel))}
    >
      ${props.tabs.map((tab) => {
        const selected = props.active === tab.value;
        return html`
          <wa-tab
            id=${`${props.id}-tab-${tab.value}`}
            panel=${tab.value}
            aria-controls=${props.panelId}
            class="hub-tab ${props.carapace ? "oc-segmented-item" : ""}"
            ?active=${selected}
            ?disabled=${tab.disabled}
            .tabIndex=${selected || tab.value === fallbackFocusValue ? 0 : -1}
            aria-selected=${selected ? "true" : "false"}
            data-test-id=${tab.testId ?? nothing}
            @click=${(event: MouseEvent) => {
              const activeElement = event.currentTarget;
              if (!(activeElement instanceof HTMLElement)) {
                return;
              }
              if (
                !tab.disabled &&
                (event.detail > 0 || event.isTrusted) &&
                tab.value !== props.active
              ) {
                props.onSelect(tab.value);
                props.onActivate?.(activeElement);
              }
            }}
            @keydown=${(event: KeyboardEvent) => {
              const activeElement = event.currentTarget;
              if (!(activeElement instanceof HTMLElement)) {
                return;
              }
              if (
                !tab.disabled &&
                !event.repeat &&
                (event.key === "Enter" || event.key === " ") &&
                tab.value !== props.active
              ) {
                event.preventDefault();
                pendingFocus = {
                  hubId: props.id,
                  tab: tab.value,
                  at: Date.now(),
                  source: activeElement,
                };
                props.onSelect(tab.value);
                props.onActivate?.(activeElement);
              }
            }}
            ${selected ? ref((element) => reclaimFocus(props.id, tab.value, element)) : nothing}
          >
            ${tab.label}${tab.count == null
              ? nothing
              : html`<span class="hub-tab__badge hub-tab__badge--count"
                  >${tab.count}</span
                >`}${tab.badge == null
              ? nothing
              : html`<span class="hub-tab__badge">${tab.badge}</span>`}
          </wa-tab>
        `;
      })}
    </wa-tab-group>
  `;
}
