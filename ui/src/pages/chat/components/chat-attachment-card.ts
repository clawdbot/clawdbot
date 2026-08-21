import { html, type TemplateResult } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import { getMediaFileExtension } from "../../../lib/media-file-extension.ts";
import type { AttachmentItem } from "./chat-message-media.ts";

type AttachmentCardKind = Extract<
  AttachmentItem["attachment"]["kind"],
  "audio" | "document" | "video"
>;

type AttachmentVisualType = "archive" | "code" | "document" | "pdf" | "text";

export type AttachmentCardHeaderOptions = {
  kind: AttachmentCardKind;
  label: string;
  mimeType?: string;
  sizeBytes?: number;
  titleHref?: string;
  downloadHref?: string;
  showDownloadLabel?: boolean;
  showExpandAction?: boolean;
  voiceNote?: boolean;
};

function attachmentVisualType(
  label: string,
  mimeType: string | undefined,
): AttachmentVisualType {
  const extension = getMediaFileExtension(label);
  const normalizedMimeType = mimeType?.trim().toLowerCase();
  if (extension === "pdf" || normalizedMimeType === "application/pdf") {
    return "pdf";
  }
  if (
    extension === "zip" ||
    extension === "tar" ||
    extension === "gz" ||
    normalizedMimeType === "application/zip"
  ) {
    return "archive";
  }
  if (
    extension === "js" ||
    extension === "jsx" ||
    extension === "ts" ||
    extension === "tsx" ||
    extension === "css" ||
    extension === "html" ||
    extension === "json" ||
    normalizedMimeType === "application/json"
  ) {
    return "code";
  }
  if (
    extension === "md" ||
    extension === "markdown" ||
    extension === "txt" ||
    extension === "csv" ||
    normalizedMimeType?.startsWith("text/")
  ) {
    return "text";
  }
  return "document";
}

function attachmentTypeLabel(
  kind: AttachmentCardKind,
  label: string,
  mimeType: string | undefined,
): string {
  if (kind === "audio") {
    return t("chat.attachments.audio");
  }
  if (kind === "video") {
    return t("chat.attachments.video");
  }
  switch (attachmentVisualType(label, mimeType)) {
    case "archive":
      return t("chat.attachments.archive");
    case "code":
      return t("chat.attachments.code");
    case "pdf":
      return t("chat.attachments.pdf");
    case "text":
      return t("chat.attachments.text");
    default:
      return t("chat.attachments.document");
  }
}

function attachmentIcon(
  kind: AttachmentCardKind,
  label: string,
  mimeType: string | undefined,
): TemplateResult {
  if (kind === "audio") {
    return icons.music;
  }
  if (kind === "video") {
    return icons.monitor;
  }
  switch (attachmentVisualType(label, mimeType)) {
    case "archive":
      return icons.archive;
    case "code":
      return icons.braces;
    case "text":
    case "pdf":
      return icons.fileText;
    default:
      return icons.paperclip;
  }
}

export function renderAttachmentCardHeader(
  options: AttachmentCardHeaderOptions,
): TemplateResult {
  const typeLabel = attachmentTypeLabel(options.kind, options.label, options.mimeType);
  const metadata = [
    typeLabel,
    options.sizeBytes !== undefined ? formatBytes(options.sizeBytes) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const title = options.titleHref
    ? html`<a
        class="chat-assistant-attachment-card__title chat-assistant-attachment-card__link"
        href=${options.titleHref}
        target="_blank"
        rel="noreferrer"
        title=${options.label}
        >${options.label}</a
      >`
    : html`<span class="chat-assistant-attachment-card__title" title=${options.label}
        >${options.label}</span
      >`;
  const downloadTitle = t("chat.mediaPlayer.download", { filename: options.label });
  return html`
    <div class="chat-assistant-attachment-card__header">
      <div class="chat-assistant-attachment-card__identity">
        <span class="chat-assistant-attachment-card__icon" aria-hidden="true"
          >${attachmentIcon(options.kind, options.label, options.mimeType)}</span
        >
        <span class="chat-assistant-attachment-card__details">
          ${title}
          <span class="chat-assistant-attachment-card__meta">${metadata}</span>
        </span>
      </div>
      <span class="chat-assistant-attachment-card__actions">
        ${options.voiceNote
          ? html`<span class="chat-assistant-attachment-badge"
              >${t("chat.messages.voiceNote")}</span
            >`
          : null}
        ${options.downloadHref
          ? html`<a
              class="chat-assistant-attachment-card__download ${options.showDownloadLabel
                ? "chat-assistant-attachment-card__download--labeled"
                : ""}"
              href=${options.downloadHref}
              download=${options.label}
              target="_blank"
              rel="noreferrer"
              aria-label=${downloadTitle}
              title=${downloadTitle}
              >${icons.download}${options.showDownloadLabel
                ? html`<span>${t("chat.attachments.download")}</span>`
                : null}</a
            >`
          : null}
        ${options.showExpandAction && options.downloadHref
          ? html`<a
              class="chat-assistant-attachment-card__download chat-assistant-attachment-card__expand"
              href=${options.downloadHref}
              target="_blank"
              rel="noreferrer"
              aria-label=${t("chat.attachments.expand", { filename: options.label })}
              title=${t("chat.attachments.expand", { filename: options.label })}
              >${icons.maximize}</a
            >`
          : null}
      </span>
    </div>
  `;
}
