import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import "../../../components/web-awesome.ts";
import { EDITOR_IDS, EDITOR_LABELS, type EditorId } from "../../../lib/editor-links.ts";

export function renderChatSidebarEditorMenu(params: {
  absolutePath: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenEditor: (editor: EditorId) => void;
}) {
  const label = params.absolutePath ? "Open in editor" : "Workspace root unknown";
  return html`
    <div class="sidebar-file-view__editor">
      <openclaw-tooltip .content=${label}>
        <wa-dropdown
          class="sidebar-file-view__editor-menu"
          placement="bottom-end"
          .open=${params.open}
          @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
            const editor = event.detail.item.value;
            if (editor && EDITOR_IDS.includes(editor as EditorId)) {
              params.onOpenEditor(editor as EditorId);
            }
          }}
          @wa-show=${() => params.onOpenChange(true)}
          @wa-hide=${() => params.onOpenChange(false)}
        >
          <button
            slot="trigger"
            class="btn btn--sm sidebar-file-view__action"
            type="button"
            aria-label=${label}
            ?disabled=${!params.absolutePath}
          >
            ${icons.externalLink}
          </button>
          ${params.absolutePath
            ? EDITOR_IDS.map(
                (editor) => html`
                  <wa-dropdown-item class="sidebar-file-view__editor-item" value=${editor}>
                    ${EDITOR_LABELS[editor]}
                  </wa-dropdown-item>
                `,
              )
            : nothing}
        </wa-dropdown>
      </openclaw-tooltip>
    </div>
  `;
}
