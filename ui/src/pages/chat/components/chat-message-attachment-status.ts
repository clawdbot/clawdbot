import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import type { AttachmentItem } from "./chat-message-media.ts";

export function renderAssistantAttachmentStatusCard(params: {
  kind: AttachmentItem["attachment"]["kind"];
  label: string;
  badge: string;
  reason?: string;
}) {
  const icon =
    params.kind === "image"
      ? icons.image
      : params.kind === "audio"
        ? icons.mic
        : params.kind === "video"
          ? icons.monitor
          : icons.paperclip;
  return html`
    <div class="chat-assistant-attachment-card chat-assistant-attachment-card--blocked">
      <div class="chat-assistant-attachment-card__header">
        <span class="chat-assistant-attachment-card__icon">${icon}</span>
        <span class="chat-assistant-attachment-card__title">${params.label}</span>
        <span class="chat-assistant-attachment-badge chat-assistant-attachment-badge--muted"
          >${params.badge}</span
        >
      </div>
      ${params.reason
        ? html`<div class="chat-assistant-attachment-card__reason">${params.reason}</div>`
        : nothing}
    </div>
  `;
}
