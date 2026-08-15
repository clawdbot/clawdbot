import { css, html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "./icons.ts";
import "./web-awesome-tabs.ts";

export type PanelTabStripTab = {
  id: string;
  domId: string;
  label: string;
  title?: string | null;
  icon?: TemplateResult | typeof nothing | null;
  statusLabel?: string | null;
  /** Short ownership marker (e.g. "agent") rendered as a pill after the label. */
  badge?: string | null;
  className?: string;
  closeLabel: string;
};

const reconciledTabOrders = new WeakMap<Element, string>();
const keyboardCloseActivations = new WeakSet<Element>();

function activeElementFor(element: Element): Element | null {
  const root = element.getRootNode();
  return root instanceof ShadowRoot
    ? (root.activeElement ?? document.activeElement)
    : document.activeElement;
}

function deepestActiveElement(): Element | null {
  let active = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

function focusNeedsRecovery(element: Element, current: Element | null): boolean {
  const root = element.getRootNode();
  return (
    current === document.body ||
    current === document.documentElement ||
    (root instanceof ShadowRoot && current === root.host)
  );
}

function reconcileSelectedTabElement(
  element: Element | undefined,
  tabOrder: string,
  restoreFocus: boolean,
): void {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  const orderChanged = reconciledTabOrders.get(element) !== tabOrder;
  reconciledTabOrders.set(element, tabOrder);
  if (!orderChanged && !restoreFocus) {
    return;
  }
  // Keyed movement can make the browser briefly focus the document or move the
  // selected tab outside the overflow viewport. Reconcile only those changes.
  queueMicrotask(() => {
    if (!element.isConnected) {
      return;
    }
    const currentGroup = element.closest("wa-tab-group");
    const updateComplete =
      (currentGroup as (HTMLElement & { updateComplete?: Promise<unknown> }) | null)
        ?.updateComplete ?? Promise.resolve();
    void updateComplete.then(() => {
      if (!element.isConnected) {
        return;
      }
      element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      const current = activeElementFor(element);
      if (restoreFocus && focusNeedsRecovery(element, current)) {
        element.focus({ preventScroll: true });
      }
    });
  });
}

export function renderPanelTabStrip(params: {
  tabs: PanelTabStripTab[];
  activeId: string | null;
  ariaControls: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void | Promise<void>;
  onNew: () => void;
  newLabel: string;
  newDisabled?: boolean;
}) {
  const newButton = (slotted: boolean) => html`
    <button
      slot=${slotted ? "nav" : nothing}
      class="rail-header__action tabstrip-new"
      type="button"
      ?disabled=${params.newDisabled}
      title=${params.newLabel}
      aria-label=${params.newLabel}
      @click=${params.onNew}
    >
      ${icons.plus}
    </button>
  `;
  if (params.tabs.length === 0) {
    // Web Awesome 3.10 dereferences its first tab when an empty group becomes
    // visible. Keep the new-session control outside the group until one exists.
    return newButton(false);
  }
  const activeElement = deepestActiveElement();
  const focusedTabDomId =
    activeElement instanceof HTMLElement &&
    params.tabs.some((tab) => tab.domId === activeElement.id)
      ? activeElement.id
      : null;
  const tabOrder = params.tabs.map((tab) => tab.id).join("\u0000");
  return html`
    <wa-tab-group
      class="tabstrip"
      .active=${params.activeId ?? ""}
      activation="auto"
      without-scroll-controls
      @wa-tab-show=${(event: CustomEvent<{ name: string }>) => params.onSelect(event.detail.name)}
    >
      ${repeat(
        params.tabs,
        (tab) => tab.id,
        (tab) => {
          const selected = tab.id === params.activeId;
          return html`
            <wa-tab
              id=${tab.domId}
              class=${`tabstrip-tab ${tab.className ?? ""}`}
              panel=${tab.id}
              aria-controls=${params.ariaControls}
              aria-selected=${selected ? "true" : "false"}
              title=${tab.title || nothing}
              ?active=${selected}
              .tabIndex=${selected ? 0 : -1}
              ${selected
                ? ref((element) =>
                    reconcileSelectedTabElement(element, tabOrder, focusedTabDomId === tab.domId),
                  )
                : nothing}
              @auxclick=${(event: MouseEvent) => {
                if (event.button === 1) {
                  event.preventDefault();
                  void params.onClose(tab.id);
                }
              }}
            >
              ${tab.icon == null || tab.icon === nothing
                ? nothing
                : html`<span class="tabstrip-tab__icon" aria-hidden="true">${tab.icon}</span>`}
              <span class="tabstrip-tab__label">${tab.label}</span>
              ${tab.badge ? html`<span class="tabstrip-tab__badge">${tab.badge}</span>` : nothing}
              ${tab.statusLabel
                ? html`<span class="tabstrip-tab__status">${tab.statusLabel}</span>`
                : nothing}
            </wa-tab>
            <button
              slot="nav"
              class="rail-header__action tabstrip-tab__close"
              type="button"
              title=${tab.closeLabel}
              aria-label=${tab.closeLabel}
              @keydown=${(event: KeyboardEvent) => {
                if (
                  (event.key === "Enter" || event.key === " ") &&
                  event.currentTarget instanceof Element
                ) {
                  keyboardCloseActivations.add(event.currentTarget);
                }
              }}
              @click=${async (event: MouseEvent) => {
                const button = event.currentTarget;
                const renderRoot =
                  button instanceof Node ? (button.getRootNode() as ParentNode) : null;
                const renderHost =
                  renderRoot instanceof ShadowRoot
                    ? (renderRoot.host as HTMLElement & { updateComplete?: Promise<unknown> })
                    : null;
                const restoreFocus =
                  button instanceof Element &&
                  (keyboardCloseActivations.delete(button) || activeElementFor(button) === button);
                await params.onClose(tab.id);
                if (!restoreFocus) {
                  return;
                }
                await renderHost?.updateComplete;
                const settledGroup = [
                  ...(renderRoot?.querySelectorAll<
                    HTMLElement & { updateComplete?: Promise<unknown> }
                  >("wa-tab-group") ?? []),
                ].find((candidate) =>
                  [...candidate.querySelectorAll<HTMLElement>("wa-tab")].some(
                    (renderedTab) =>
                      renderedTab.getAttribute("aria-controls") === params.ariaControls,
                  ),
                );
                await settledGroup?.updateComplete;
                const closingTab = [
                  ...(settledGroup?.querySelectorAll<HTMLElement>("wa-tab") ?? []),
                ].find((candidate) => candidate.getAttribute("panel") === tab.id);
                const fallback = settledGroup?.querySelector<HTMLElement>("wa-tab[active]");
                const current = fallback ? activeElementFor(fallback) : null;
                if (!closingTab && fallback && focusNeedsRecovery(fallback, current)) {
                  fallback.focus({ preventScroll: true });
                }
              }}
            >
              <span class="tabstrip-tab__close-box">${icons.x}</span>
            </button>
          `;
        },
      )}
      ${newButton(true)}
    </wa-tab-group>
  `;
}

export const panelTabStripStyles = css`
  .tabstrip {
    --track-width: 0;
    display: block;
    /* Allow the strip to shrink inside a flex header so wide tab rows scroll
       here instead of squeezing out sibling header controls. */
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabstrip::part(nav) {
    display: flex;
    align-items: stretch;
  }
  .tabstrip::part(body) {
    display: none;
  }
  .tabstrip::-webkit-scrollbar {
    display: none;
  }
  .tabstrip-tab::part(base) {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 4px 0 10px;
    height: 36px;
    color: var(--muted, #8a919e);
    white-space: nowrap;
    font-size: 12.5px;
    border-bottom: 2px solid transparent;
    transition:
      color 0.12s ease,
      background 0.12s ease;
  }
  .tabstrip-tab:hover::part(base) {
    color: var(--text, #d7dae0);
    background: color-mix(in srgb, var(--text, #d7dae0) 6%, transparent);
  }
  .tabstrip-tab[active]::part(base) {
    color: var(--text, #d7dae0);
    border-bottom-color: var(--accent, #ff5c5c);
  }
  .tabstrip-tab.is-exited::part(base) {
    opacity: 0.55;
  }
  .tabstrip-tab.is-connecting .tabstrip-tab__icon {
    animation: tabstrip-pulse 1.2s ease-in-out infinite;
  }
  .tabstrip-tab__icon {
    display: inline-flex;
    color: var(--accent, #ff5c5c);
  }
  .tabstrip-tab.is-exited .tabstrip-tab__icon {
    color: var(--muted, #8a919e);
  }
  .tabstrip-tab__label {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .tabstrip-tab__status {
    font-size: 11px;
    color: var(--muted, #8a919e);
  }
  .tabstrip-tab__badge {
    border: 1px solid color-mix(in srgb, var(--accent, #ff5c5c) 45%, transparent);
    border-radius: 999px;
    color: var(--accent, #ff5c5c);
    font-size: 9px;
    line-height: 14px;
    padding: 0 5px;
    text-transform: uppercase;
  }
  /* Each close button sits right after its tab in the nav slot. The tab keeps
     the active surface; the action itself follows the bare rail-control contract. */
  .tabstrip-tab__close {
    flex: 0 0 auto;
    align-self: center;
    margin-right: 1px;
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .tabstrip-tab__close-box {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 5px;
  }
  :where(.tabstrip-tab:hover, .tabstrip-tab[active]) + .tabstrip-tab__close,
  .tabstrip-tab__close:hover,
  .tabstrip-tab__close:focus-visible {
    opacity: 1;
  }
  .tabstrip-new {
    flex: none;
    align-self: center;
  }
  @keyframes tabstrip-pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tabstrip-tab.is-connecting .tabstrip-tab__icon {
      animation: none;
    }
  }
`;
