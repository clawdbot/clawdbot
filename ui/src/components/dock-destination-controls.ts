import { html, nothing, type TemplateResult } from "lit";
import "./tooltip.ts";

type DockDestinationOption<Dock extends string> = {
  dock: Dock;
  label: string;
  icon: TemplateResult;
  /** Extra class for surfaces that target a single destination in tests. */
  className?: string;
};

/**
 * Renders a rail's dock cluster as destinations only: the dock a panel already
 * sits in has nowhere to move to, so it drops out of the row instead of
 * rendering as a coloured pressed state. Both the side panel and the terminal
 * panel share this policy, so the filtering and the button shape live here.
 */
export function renderDockDestinations<Dock extends string>(params: {
  current: Dock;
  destinations: readonly DockDestinationOption<Dock>[];
  groupClass: string;
  groupLabel: string;
  onSelect: (dock: Dock) => void;
}) {
  const alternatives = params.destinations.filter((option) => option.dock !== params.current);
  if (alternatives.length === 0) {
    return nothing;
  }
  return html`<span class=${params.groupClass} role="group" aria-label=${params.groupLabel}>
    ${alternatives.map(
      (option) => html`<openclaw-tooltip .content=${option.label}>
        <button
          class=${`rail-header__action ${option.className ?? ""}`}
          type="button"
          aria-label=${option.label}
          @click=${() => params.onSelect(option.dock)}
        >
          ${option.icon}
        </button>
      </openclaw-tooltip>`,
    )}
  </span>`;
}
