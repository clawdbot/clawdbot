import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import type { BoardViewWidget, BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";

export function renderBoardWidgetFrame(
  widget: BoardViewWidget,
  resolveFrameUrl: BoardWidgetFrameUrl | undefined,
  resolved: (src: string) => void,
  loadFailed: () => void,
  loaded: (event: Event) => void,
): TemplateResult {
  if (!resolveFrameUrl) {
    throw new Error(t("board.widget.frameResolverMissing"));
  }
  const src = resolveFrameUrl(widget.name, widget.revision);
  resolved(src);
  return html`
    <iframe
      class="board-widget__frame"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      loading="lazy"
      title=${widget.title || widget.name}
      src=${src}
      @error=${loadFailed}
      @load=${loaded}
    ></iframe>
  `;
}
