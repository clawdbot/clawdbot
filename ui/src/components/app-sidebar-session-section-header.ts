import { html, nothing, type TemplateResult } from "lit";
import { writeSidebarSectionDragData } from "../lib/sessions/drag.ts";

export function renderSidebarSessionSectionHeader(params: {
  sectionId: string;
  content: TemplateResult;
  disabledReason?: string;
  onStartDrag: (sectionId: string) => void;
  onFinishDrag: () => void;
  onContextMenu?: (event: MouseEvent) => void;
}) {
  return html`
    <div
      class="sidebar-recent-sessions__head ${params.disabledReason
        ? ""
        : "sidebar-recent-sessions__head--draggable"}"
      draggable=${params.disabledReason ? "false" : "true"}
      title=${params.disabledReason ?? nothing}
      @mousedown=${(event: MouseEvent) => {
        const header = event.currentTarget as HTMLElement;
        header.toggleAttribute(
          "data-section-drag-blocked",
          Boolean((event.target as HTMLElement).closest("button")),
        );
      }}
      @mouseup=${(event: MouseEvent) => {
        (event.currentTarget as HTMLElement).removeAttribute("data-section-drag-blocked");
      }}
      @dragstart=${(event: DragEvent) => {
        if (params.disabledReason) {
          event.preventDefault();
          return;
        }
        const header = event.currentTarget as HTMLElement;
        const startedFromButton =
          Boolean((event.target as HTMLElement).closest("button")) ||
          header.hasAttribute("data-section-drag-blocked");
        header.removeAttribute("data-section-drag-blocked");
        if (startedFromButton) {
          event.preventDefault();
          return;
        }
        if (event.dataTransfer) {
          writeSidebarSectionDragData(event.dataTransfer, params.sectionId);
          params.onStartDrag(params.sectionId);
        }
      }}
      @dragend=${(event: DragEvent) => {
        (event.currentTarget as HTMLElement).removeAttribute("data-section-drag-blocked");
        params.onFinishDrag();
      }}
      @contextmenu=${params.onContextMenu ?? nothing}
    >
      <span class="sidebar-session-group-drag-handle" aria-hidden="true"></span>
      ${params.content}
    </div>
  `;
}
