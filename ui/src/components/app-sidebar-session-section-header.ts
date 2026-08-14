import { html, nothing, type TemplateResult } from "lit";
import { writeSidebarSectionDragData } from "../lib/sessions/drag.ts";
import { icons } from "./icons.ts";

/** One signal per section head, so a count and a dot can never compete. */
export type SidebarSectionStatus =
  | { kind: "none" }
  | { kind: "running"; label: string }
  | { kind: "unread"; label: string }
  | { kind: "attention"; label: string }
  | { kind: "error"; label: string };

export const SIDEBAR_SECTION_NO_STATUS: SidebarSectionStatus = { kind: "none" };

function renderSidebarSectionStatus(status: SidebarSectionStatus) {
  if (status.kind === "none") {
    return nothing;
  }
  const className =
    status.kind === "running"
      ? "session-run-spinner sidebar-session-group-status"
      : `sidebar-session-group-status sidebar-session-group-status--${status.kind}`;
  return html`<span
    class=${className}
    data-section-status=${status.kind}
    role="img"
    aria-label=${status.label}
    title=${status.label}
  ></span>`;
}

/**
 * Shared label/disclosure/count grammar for native groups, provider catalogs,
 * and project subgroups. A section whose status dot already reports attention
 * drops its row count, which would otherwise say the same thing twice.
 */
export function renderSidebarSessionSectionToggle(params: {
  label: string;
  collapsed: boolean;
  status: SidebarSectionStatus;
  className?: string;
  labelClassName?: string;
  ariaLabel?: string;
  title?: string;
  lead?: TemplateResult;
  count?: number;
  onToggle: () => void;
}): TemplateResult {
  const showCount = params.status.kind === "none" && params.count !== undefined && params.count > 0;
  return html`<button
    type="button"
    class=${params.className ?? "sidebar-session-group-toggle"}
    aria-expanded=${String(!params.collapsed)}
    aria-label=${params.ariaLabel ?? params.label}
    title=${params.title ?? nothing}
    @click=${() => params.onToggle()}
  >
    ${params.lead ?? nothing}
    <span class=${params.labelClassName ?? "sidebar-recent-sessions__label-text"}
      >${params.label}</span
    >
    <span
      class="sidebar-session-group-toggle__icon ${params.collapsed
        ? "sidebar-session-group-toggle__icon--collapsed"
        : ""}"
      aria-hidden="true"
      >${params.collapsed ? icons.chevronRight : icons.chevronDown}</span
    >
    ${showCount
      ? html`<span class="sidebar-session-group-count" aria-hidden="true">${params.count}</span>`
      : nothing}
  </button>`;
}

export function renderSidebarSessionSectionHeader(params: {
  sectionId: string;
  content: TemplateResult;
  status: SidebarSectionStatus;
  disabledReason?: string;
  onToggle: () => void;
  onStartDrag: (sectionId: string) => void;
  onFinishDrag: () => void;
  onContextMenu?: (event: MouseEvent) => void;
}) {
  return html`
    <div
      class="sidebar-recent-sessions__head"
      title=${params.disabledReason ?? nothing}
      @contextmenu=${params.onContextMenu ?? nothing}
    >
      <span
        class="sidebar-session-group-drag-handle"
        aria-hidden="true"
        draggable=${params.disabledReason ? "false" : "true"}
        @click=${params.onToggle}
        @dragstart=${(event: DragEvent) => {
          if (params.disabledReason) {
            event.preventDefault();
            return;
          }
          if (event.dataTransfer) {
            writeSidebarSectionDragData(event.dataTransfer, params.sectionId);
            params.onStartDrag(params.sectionId);
          }
        }}
        @dragend=${params.onFinishDrag}
        >${icons.gripVertical}</span
      >
      ${params.content} ${renderSidebarSectionStatus(params.status)}
    </div>
  `;
}
