import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { renderAttachmentCardIcon } from "./chat-attachment-card.ts";
import type { AttachmentItem } from "./chat-message-media.ts";

export function renderAssistantAttachmentStatusCard(params: {
  kind: AttachmentItem["attachment"]["kind"];
  label: string;
  badge: string;
  reason?: string;
  onRetry?: () => void;
}) {
  const unavailable = params.reason !== undefined;
  const recoverable = unavailable && params.onRetry !== undefined;
  const statusClass = unavailable
    ? recoverable
      ? "chat-assistant-attachment-card--recoverable"
      : "chat-assistant-attachment-card--definitive"
    : "chat-assistant-attachment-card--checking";
  return html`
    <div
      class="chat-assistant-attachment-card chat-assistant-attachment-card--blocked ${statusClass}"
    >
      <div class="chat-assistant-attachment-card__header">
        <div class="chat-assistant-attachment-card__identity">
          ${renderAttachmentCardIcon({
            kind: params.kind,
            label: params.label,
            compact: true,
            unavailable,
          })}
          <span class="chat-assistant-attachment-card__details">
            <span
              class="chat-assistant-attachment-card__title ${unavailable
                ? "chat-assistant-attachment-card__title--unavailable"
                : ""}"
              title=${params.label}
              >${params.label}</span
            >
            <span class="chat-assistant-attachment-card__meta chat-assistant-attachment-card__status-meta"
              >${params.badge}${params.reason ? ` · ${params.reason}` : ""}</span
            >
          </span>
        </div>
        ${params.onRetry
          ? html`<button
              class="chat-assistant-attachment-card__action chat-assistant-attachment-card__action--labeled chat-assistant-attachment-card__retry"
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
