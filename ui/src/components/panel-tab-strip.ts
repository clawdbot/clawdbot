import { css, html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "./icons.ts";
import "./tooltip.ts";
import "./web-awesome-tabs.ts";

export type PanelTabStripTab = {
  id: string;
  domId: string;
  label: string;
  labelTooltip?: string | null;
  title?: string | null;
  icon?: TemplateResult | typeof nothing | null;
  statusLabel?: string | null;
  /** Short ownership marker (e.g. "agent") rendered as a pill after the label. */
  badge?: string | null;
  className?: string;
  closeLabel: string;
};

const reconciledTabLayouts = new WeakMap<Element, string>();
const keyboardCloseActivations = new WeakSet<Element>();
const PANEL_TAB_DRAG_TYPE = "application/x-openclaw-panel-tab";

function clearPanelTabDropTargets(element: Element): void {
  const group = element.closest<HTMLElement>("wa-tab-group");
  group
    ?.querySelectorAll(".is-drop-before, .is-drop-after")
    .forEach((target) => target.classList.remove("is-drop-before", "is-drop-after"));
}

function draggedPanelTabId(element: Element): string {
  return element.closest<HTMLElement>("wa-tab-group")?.dataset.draggedPanelTab ?? "";
}

function finishPanelTabDrag(element: Element): void {
  clearPanelTabDropTargets(element);
  element.closest<HTMLElement>("wa-tab-group")?.removeAttribute("data-dragged-panel-tab");
}

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

function panelTabLabelOverflowRef() {
  let resizeObserver: ResizeObserver | null = null;
  return (element: Element | undefined) => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const update = () => {
      const overflowing = element.scrollWidth > element.clientWidth + 1;
      element.classList.toggle("is-overflowing", overflowing);
      element.parentElement?.classList.toggle("has-label-overflow", overflowing);
      element.toggleAttribute("data-tooltip-overflow", overflowing);
    };
    update();
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(update);
      resizeObserver.observe(element);
    }
  };
}

/** Marks which edges of the tab row still hide tabs, so CSS can fade them out
 *  instead of letting the scroller slice a pill into an icon-only stub. Edges
 *  are measured from client rects because `scrollLeft` flips sign under RTL,
 *  while rects — and the fade masks they drive — are always physical. */
function panelTabScrollEdgesRef() {
  let resizeObserver: ResizeObserver | null = null;
  let detach: (() => void) | null = null;
  // Installation resumes after an await, so a ref swap inside that window has to
  // cancel the pending body; otherwise its listener and observer outlive every
  // cleanup and accumulate once per render.
  let generation = 0;
  return (element: Element | undefined) => {
    generation += 1;
    const installing = generation;
    resizeObserver?.disconnect();
    resizeObserver = null;
    detach?.();
    detach = null;
    if (!(element instanceof HTMLElement)) {
      return;
    }
    void (async () => {
      // The scroller is the group's own tabs part, so wait for its first render.
      await (element as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete;
      const scroller = element.shadowRoot?.querySelector<HTMLElement>('[part~="tabs"]');
      if (!scroller || !element.isConnected || installing !== generation) {
        return;
      }
      const update = () => {
        // Ignore sub-pixel and padding-sized offsets so a resting row does not
        // fade its first tab for the scroller's own inline padding.
        const edgeSlack = 8;
        const rects = [...element.children].map((item) => item.getBoundingClientRect());
        if (rects.length === 0) {
          return;
        }
        const viewport = scroller.getBoundingClientRect();
        const contentLeft = Math.min(...rects.map((rect) => rect.left));
        const contentRight = Math.max(...rects.map((rect) => rect.right));
        element.classList.toggle("has-scroll-left", viewport.left - contentLeft > edgeSlack);
        element.classList.toggle("has-scroll-right", contentRight - viewport.right > edgeSlack);
      };
      update();
      scroller.addEventListener("scroll", update, { passive: true });
      detach = () => scroller.removeEventListener("scroll", update);
      if (typeof ResizeObserver === "function") {
        resizeObserver = new ResizeObserver(update);
        resizeObserver.observe(scroller);
      }
    })();
  };
}

/** "before"/"after" are array order, but pointer position is physical: under RTL
 *  the visually leading half of a tab is its right half. Both drag handlers read
 *  this, or the indicator previews the opposite edge from the actual drop. */
function panelTabDropPlacement(event: DragEvent, target: Element): "before" | "after" {
  const bounds = target.getBoundingClientRect();
  const pastMidpoint = event.clientX > bounds.left + bounds.width / 2;
  const isRtl = getComputedStyle(target).direction === "rtl";
  return pastMidpoint === isRtl ? "before" : "after";
}

function reconcileSelectedTabElement(
  element: Element | undefined,
  layoutKey: string,
  restoreFocus: boolean,
): void {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  const layoutChanged = reconciledTabLayouts.get(element) !== layoutKey;
  reconciledTabLayouts.set(element, layoutKey);
  if (!layoutChanged && !restoreFocus) {
    return;
  }
  // Keyed movement or a new selection can leave the active tab clipped by the
  // overflow viewport, which reads as an icon-only tab. Reconcile those changes.
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
  newTabAction?: boolean;
  newControl?: TemplateResult | typeof nothing;
  separateTabs?: boolean;
  onReorder?: (sourceId: string, targetId: string, placement: "before" | "after") => void;
}) {
  const newButton = (slotted: boolean) =>
    params.newControl === nothing
      ? nothing
      : params.newControl
        ? html`<span slot=${slotted ? "nav" : nothing} class="tabstrip-new-control"
            >${params.newControl}</span
          >`
        : html`
            <button
              slot=${slotted ? "nav" : nothing}
              class="rail-header__action tabstrip-new"
              type="button"
              ?data-new-tab-action=${params.newTabAction}
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
  // Selection belongs in the key: activating a clipped tab has to scroll it back
  // into view, otherwise it stays cut off at the viewport edge as icon-only.
  // Serialized rather than joined: a delimiter can appear inside an id, and two
  // different layouts must never produce the same key.
  const layoutKey = JSON.stringify([params.activeId, params.tabs.map((tab) => tab.id)]);
  return html`
    <wa-tab-group
      class="tabstrip"
      ${ref(panelTabScrollEdgesRef())}
      .active=${params.activeId ?? ""}
      activation="auto"
      without-scroll-controls
      @wa-tab-show=${(event: CustomEvent<{ name: string }>) => params.onSelect(event.detail.name)}
    >
      ${repeat(
        params.tabs,
        (tab) => tab.id,
        (tab, index) => {
          const selected = tab.id === params.activeId;
          // Every gap keeps its separator so activating a tab cannot reflow the
          // row; the pair touching the active tab is faded out in CSS instead.
          const showSeparator = params.separateTabs === true && index < params.tabs.length - 1;
          const tabContent = html`
            ${
              tab.icon == null || tab.icon === nothing
                ? nothing
                : html`<span class="tabstrip-tab__icon" aria-hidden="true">${tab.icon}</span>`
            }
            <span class="tabstrip-tab__label" ${ref(panelTabLabelOverflowRef())}>${tab.label}</span>
            ${tab.badge ? html`<span class="tabstrip-tab__badge">${tab.badge}</span>` : nothing}
            ${
              tab.statusLabel
                ? html`<span class="tabstrip-tab__status">${tab.statusLabel}</span>`
                : nothing
            }
          `;
          return html`
            <wa-tab
              id=${tab.domId}
              class=${`tabstrip-tab ${tab.className ?? ""}`}
              panel=${tab.id}
              aria-controls=${params.ariaControls}
              aria-selected=${selected ? "true" : "false"}
              title=${tab.title || nothing}
              ?active=${selected}
              draggable=${params.onReorder ? "true" : nothing}
              .tabIndex=${selected ? 0 : -1}
              ${
                selected
                  ? ref((element) =>
                      reconcileSelectedTabElement(
                        element,
                        layoutKey,
                        focusedTabDomId === tab.domId,
                      ),
                    )
                  : nothing
              }
              @auxclick=${(event: MouseEvent) => {
                if (event.button === 1) {
                  event.preventDefault();
                  void params.onClose(tab.id);
                }
              }}
              @dragstart=${(event: DragEvent) => {
                if (!params.onReorder || !event.dataTransfer) {
                  return;
                }
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(PANEL_TAB_DRAG_TYPE, tab.id);
                if (event.currentTarget instanceof Element) {
                  const group = event.currentTarget.closest<HTMLElement>("wa-tab-group");
                  if (group) {
                    group.dataset.draggedPanelTab = tab.id;
                  }
                }
              }}
              @dragover=${(event: DragEvent) => {
                if (!params.onReorder || !event.dataTransfer) {
                  return;
                }
                const sourceId =
                  event.currentTarget instanceof Element
                    ? draggedPanelTabId(event.currentTarget)
                    : "";
                if (!sourceId || sourceId === tab.id) {
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const target = event.currentTarget;
                if (!(target instanceof Element)) {
                  return;
                }
                clearPanelTabDropTargets(target);
                target.classList.add(`is-drop-${panelTabDropPlacement(event, target)}`);
              }}
              @dragleave=${(event: DragEvent) => {
                if (
                  event.currentTarget instanceof Element &&
                  !(
                    event.relatedTarget instanceof Node &&
                    event.currentTarget.contains(event.relatedTarget)
                  )
                ) {
                  event.currentTarget.classList.remove("is-drop-before", "is-drop-after");
                }
              }}
              @drop=${(event: DragEvent) => {
                if (!params.onReorder || !event.dataTransfer) {
                  return;
                }
                const target = event.currentTarget;
                const sourceId =
                  target instanceof Element
                    ? draggedPanelTabId(target) || event.dataTransfer.getData(PANEL_TAB_DRAG_TYPE)
                    : "";
                if (!sourceId || sourceId === tab.id || !(target instanceof Element)) {
                  return;
                }
                event.preventDefault();
                const placement = panelTabDropPlacement(event, target);
                finishPanelTabDrag(target);
                params.onReorder(sourceId, tab.id, placement);
              }}
              @dragend=${(event: DragEvent) => {
                if (event.currentTarget instanceof Element) {
                  finishPanelTabDrag(event.currentTarget);
                }
              }}
            >
              ${
                tab.labelTooltip
                  ? html`<openclaw-tooltip
                      class="tabstrip-tab__label-tooltip"
                      .content=${tab.labelTooltip}
                    >
                      <span class="tabstrip-tab__tooltip-trigger">${tabContent}</span>
                    </openclaw-tooltip>`
                  : tabContent
              }
            </wa-tab>
            <button
              slot="nav"
              class="rail-header__action tabstrip-tab__close"
              type="button"
              .tabIndex=${selected ? 0 : -1}
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
            ${
              showSeparator
                ? html`<span slot="nav" class="tabstrip-separator" aria-hidden="true"></span>`
                : nothing
            }
          `;
        },
      )}
      ${newButton(true)}
    </wa-tab-group>
  `;
}

export const panelTabStripStyles = css`
  :where(.tp-header, .bp-header) {
    --rail-header-height: 46px;
    --rail-header-padding-start: 8px;
  }
  :where(.tp-actions, .bp-actions) {
    padding-left: 8px;
    border-left: 1px solid var(--border, #262b34);
  }
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
    align-items: center;
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
    height: 30px;
    padding: 0 34px 0 10px;
    border: 0;
    border-radius: 7px;
    color: var(--muted, #8a919e);
    white-space: nowrap;
    font-size: 12.5px;
    transition:
      color 0.12s ease,
      background 0.12s ease,
      box-shadow 0.12s ease;
  }
  .tabstrip-tab:hover::part(base) {
    color: var(--text, #d7dae0);
    background: color-mix(in srgb, var(--text, #d7dae0) 6%, transparent);
  }
  .tabstrip-tab[active]::part(base) {
    color: var(--text, #d7dae0);
    background: var(--bg-hover, #1f2330);
    box-shadow: inset 0 0 0 1px var(--border-strong, #2e3040);
  }
  .tabstrip-tab.is-exited:not([active])::part(base) {
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
  .tabstrip-tab__tooltip-trigger {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: inherit;
    flex: 1 1 auto;
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
  /* Keep the close action inside the tab surface without nesting it in wa-tab;
     wa-tab-group still owns the direct tab children for keyboard navigation. */
  .tabstrip-tab__close {
    flex: 0 0 auto;
    align-self: center;
    z-index: 1;
    margin-left: -32px;
    margin-right: 4px;
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
    margin-left: 2px;
  }
  .tabstrip-new-control {
    display: inline-flex;
    flex: none;
    align-self: center;
  }
  .tabstrip-separator {
    flex: 0 0 auto;
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
