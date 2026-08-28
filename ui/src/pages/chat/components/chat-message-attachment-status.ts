import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { renderAttachmentCardIcon } from "./chat-attachment-card.ts";
import type { AttachmentItem } from "./chat-message-media.ts";

type AttachmentFailureCode = "file-not-found" | "unsupported-format" | "delivery-failed";

export function attachmentFailureReason(code: AttachmentFailureCode): string {
  return code === "file-not-found"
    ? t("chat.attachments.failureFileNotFound")
    : code === "unsupported-format"
      ? t("chat.attachments.failureUnsupportedFormat")
      : t("chat.attachments.failureDeliveryFailed");
}

export function renderAssistantAttachmentStatusCard(params: {
  kind: AttachmentItem["attachment"]["kind"];
  label: string;
  mimeType?: string;
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
            label: params.label,
            mimeType: params.mimeType,
            visualMode: "large-placeholder",
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
            <span
              class="chat-assistant-attachment-card__meta chat-assistant-attachment-card__status-meta"
            >
              <span class="chat-assistant-attachment-card__status-badge">${params.badge}</span>
              ${params.reason
                ? html`
                    <span
                      class="chat-assistant-attachment-card__status-separator"
                      aria-hidden="true"
                      >·</span
                    >
                    <span class="chat-assistant-attachment-card__status-reason"
                      >${params.reason}</span
                    >
                  `
                : nothing}
            </span>
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
