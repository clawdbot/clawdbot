import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { renderAttachmentCardHeader } from "./chat-attachment-card.ts";
import type { AttachmentItem } from "./chat-message-media.ts";

export function renderAssistantAttachmentStatusCard(params: {
  kind: AttachmentItem["attachment"]["kind"];
  label: string;
  badge: string;
  reason?: string;
  onRetry?: () => void;
}) {
  return html`
    <div class="chat-assistant-attachment-card chat-assistant-attachment-card--blocked">
      ${renderAttachmentCardHeader({
        kind: params.kind,
        label: params.label,
        compact: true,
      })}
      <div class="chat-assistant-attachment-card__status-line">
        <span class="chat-assistant-attachment-card__reason"
          >${params.reason ?? params.badge}</span
        >
        ${params.onRetry
          ? html`<button
              class="chat-assistant-attachment-card__retry"
              type="button"
              @click=${params.onRetry}
            >
              ${icons.refresh} ${t("common.retry")}
            </button>`
          : nothing}
      </div>
    </div>
  `;
}
