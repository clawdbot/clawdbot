import { html, nothing, type TemplateResult } from "lit";
import { writeSidebarSectionDragData } from "../lib/sessions/drag.ts";
import { icons } from "./icons.ts";

export function renderSidebarSessionSectionHeader(params: {
  sectionId: string;
  content: TemplateResult;
  disabledReason?: string;
  onToggle: () => void;
  onStartDrag: (sectionId: string) => void;
  onFinishDrag: () => void;
  onContextMenu?: (event: MouseEvent) => void;
}) {
  return html`
    <div
      class="sidebar-recent-sessions__head ${params.disabledReason
        ? ""
        : "sidebar-recent-sessions__head--draggable"}"
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
      ${params.content}
    </div>
  `;
}
