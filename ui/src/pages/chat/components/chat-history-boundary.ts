// In-flow "earlier history" boundary rendered above the virtualized transcript.
import { html, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";

export type ChatHistoryBoundaryProps = {
  hasMore: boolean;
  loading: boolean;
  onShowEarlier: () => void;
};

// Must match the CSS `height` of .chat-history-boundary: the value becomes the
// virtualizer's scrollMargin, and any drift misaligns row offsets by the delta.
export const CHAT_HISTORY_BOUNDARY_HEIGHT_PX = 44;

export function renderChatHistoryBoundary(props: ChatHistoryBoundaryProps): TemplateResult {
  return html`
    <div class="chat-history-boundary ${props.loading ? "chat-history-boundary--loading" : ""}">
      <span class="chat-history-boundary__line" aria-hidden="true"></span>
      <button
        class="chat-history-boundary__action"
        type="button"
        ?disabled=${props.loading}
        aria-busy=${props.loading ? "true" : "false"}
        aria-label=${t("chat.thread.showEarlier")}
        @click=${props.onShowEarlier}
      >
        <span aria-hidden="true">${t("chat.thread.showEarlier")}</span>
        <span class="sr-only" role="status">
          ${props.loading ? t("chat.thread.loadingEarlier") : t("chat.thread.showEarlier")}
        </span>
      </button>
      <span class="chat-history-boundary__line" aria-hidden="true"></span>
    </div>
  `;
}
