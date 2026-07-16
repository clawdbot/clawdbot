import { css, html, nothing, svg, type TemplateResult } from "lit";
import "./web-awesome-tabs.ts";

export type PanelTabStripTab = {
  id: string;
  domId: string;
  label: string;
  title?: string | null;
  icon?: TemplateResult | typeof nothing | null;
  statusLabel?: string | null;
  className?: string;
  closeLabel: string;
};

const CLOSE_GLYPH = svg`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>`;
const PLUS_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3v10M3 8h10" /></svg>`;

export function renderPanelTabStrip(params: {
  tabs: PanelTabStripTab[];
  activeId: string | null;
  ariaControls: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  newLabel: string;
  newDisabled?: boolean;
}) {
  const newButton = (slotted: boolean) => html`
    <button
      slot=${slotted ? "nav" : nothing}
      class="tabstrip-new"
      type="button"
      ?disabled=${params.newDisabled}
      title=${params.newLabel}
      aria-label=${params.newLabel}
      @click=${params.onNew}
    >
      ${PLUS_GLYPH}
    </button>
  `;
  if (params.tabs.length === 0) {
    // Web Awesome 3.10 dereferences its first tab when an empty group becomes
    // visible. Keep the new-session control outside the group until one exists.
    return newButton(false);
  }
  return html`
    <wa-tab-group
      class="tabstrip"
      .active=${params.activeId ?? ""}
      activation="auto"
      without-scroll-controls
      @wa-tab-show=${(event: CustomEvent<{ name: string }>) => params.onSelect(event.detail.name)}
    >
      ${params.tabs.map(
        (tab) => html`
          <wa-tab
            id=${tab.domId}
            class=${`tabstrip-tab ${tab.className ?? ""}`}
            panel=${tab.id}
            aria-controls=${params.ariaControls}
            title=${tab.title || nothing}
            @auxclick=${(event: MouseEvent) => {
              if (event.button === 1) {
                event.preventDefault();
                params.onClose(tab.id);
              }
            }}
          >
            ${tab.icon == null || tab.icon === nothing
              ? nothing
              : html`<span class="tabstrip-tab__icon" aria-hidden="true">${tab.icon}</span>`}
            <span class="tabstrip-tab__label">${tab.label}</span>
            ${tab.statusLabel
              ? html`<span class="tabstrip-tab__status">${tab.statusLabel}</span>`
              : nothing}
          </wa-tab>
          <button
            slot="nav"
            class="tabstrip-tab__close"
            type="button"
            title=${tab.closeLabel}
            aria-label=${tab.closeLabel}
            @click=${() => params.onClose(tab.id)}
          >
            <span class="tabstrip-tab__close-box">${CLOSE_GLYPH}</span>
          </button>
        `,
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
    color: var(--accent, #4ec9a8);
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
  /* Each close button sits right after its tab in the nav slot; the pair is
     styled as one surface (shared hover background, shared active underline)
     while the X keeps its own inner highlight. */
  .tabstrip-tab__close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    align-self: stretch;
    flex: 0 0 auto;
    width: 24px;
    margin-right: 1px;
    padding: 0 4px 0 0;
    opacity: 0;
    border: none;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--muted, #8a919e);
    transition:
      color 0.12s ease,
      background 0.12s ease,
      opacity 0.12s ease;
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
  .tabstrip-tab:hover + .tabstrip-tab__close,
  .tabstrip-tab__close:hover,
  .tabstrip-tab__close:focus-visible {
    background: color-mix(in srgb, var(--text, #d7dae0) 6%, transparent);
  }
  /* Back-propagate hover from the X to its tab so the pair lights up together. */
  .tabstrip-tab:has(+ .tabstrip-tab__close:hover)::part(base),
  .tabstrip-tab:has(+ .tabstrip-tab__close:focus-visible)::part(base) {
    color: var(--text, #d7dae0);
    background: color-mix(in srgb, var(--text, #d7dae0) 6%, transparent);
  }
  .tabstrip-tab[active] + .tabstrip-tab__close {
    border-bottom-color: var(--accent, #ff5c5c);
  }
  .tabstrip-tab__close:hover,
  .tabstrip-tab__close:focus-visible {
    color: var(--text, #d7dae0);
  }
  .tabstrip-tab__close:hover .tabstrip-tab__close-box,
  .tabstrip-tab__close:focus-visible .tabstrip-tab__close-box {
    background: color-mix(in srgb, var(--text, #d7dae0) 14%, transparent);
  }
  .tabstrip-new {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    align-self: center;
    width: 26px;
    height: 26px;
    border: none;
    background: transparent;
    color: var(--muted, #8a919e);
    border-radius: 6px;
    padding: 0;
  }
  .tabstrip-new:hover {
    background: color-mix(in srgb, var(--text, #d7dae0) 12%, transparent);
    color: var(--text, #d7dae0);
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
