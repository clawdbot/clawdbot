import { html, type TemplateResult } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import { getMediaFileExtension } from "../../../lib/media-file-extension.ts";
import type { AttachmentItem } from "./chat-message-media.ts";

type AttachmentCardKind = Extract<
  AttachmentItem["attachment"]["kind"],
  "audio" | "document" | "image" | "video"
>;

type AttachmentVisualType =
  | "archive"
  | "code"
  | "document"
  | "pdf"
  | "spreadsheet"
  | "text";

export type AttachmentCardHeaderOptions = {
  kind: AttachmentCardKind;
  label: string;
  mimeType?: string;
  sizeBytes?: number;
  titleHref?: string;
  downloadHref?: string;
  showDownloadLabel?: boolean;
  showExpandAction?: boolean;
  compact?: boolean;
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
    extension === "csv" ||
    extension === "xls" ||
    extension === "xlsx" ||
    normalizedMimeType === "text/csv" ||
    normalizedMimeType === "application/vnd.ms-excel" ||
    normalizedMimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return "spreadsheet";
  }
  if (
    extension === "js" ||
    extension === "jsx" ||
    extension === "ts" ||
    extension === "tsx" ||
    extension === "css" ||
    extension === "html" ||
    extension === "py" ||
    extension === "xml" ||
    extension === "yaml" ||
    extension === "yml" ||
    extension === "json" ||
    normalizedMimeType === "application/json"
  ) {
    return "code";
  }
  if (
    extension === "md" ||
    extension === "markdown" ||
    extension === "txt" ||
    extension === "rtf" ||
    normalizedMimeType?.startsWith("text/")
  ) {
    return "text";
  }
  return "document";
}

function attachmentFormatLabel(
  kind: AttachmentCardKind,
  label: string,
  mimeType: string | undefined,
): string {
  const extension = getMediaFileExtension(label);
  if (extension) {
    return extension.toUpperCase();
  }
  const normalizedMimeType = mimeType?.trim().toLowerCase();
  if (normalizedMimeType === "application/pdf") {
    return "PDF";
  }
  if (normalizedMimeType === "application/zip") {
    return "ZIP";
  }
  if (kind === "audio") {
    return "AUDIO";
  }
  if (kind === "video") {
    return "VIDEO";
  }
  return "FILE";
}

export function attachmentCardGroup(
  kind: AttachmentCardKind,
  label: string,
  mimeType: string | undefined,
): "archive" | "audio" | "document" | "image" | "video" {
  if (kind === "image") {
    return "image";
  }
  if (kind === "audio" || kind === "video") {
    return kind;
  }
  return attachmentVisualType(label, mimeType) === "archive" ? "archive" : "document";
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
  if (kind === "image") {
    return t("chat.attachments.attachedFile");
  }
  return attachmentFormatLabel(kind, label, mimeType);
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
      return icons.fileCode;
    case "pdf":
    case "spreadsheet":
    case "text":
      return icons.fileText;
    default:
      return icons.file;
  }
}

function attachmentIconClass(
  kind: AttachmentCardKind,
  label: string,
  mimeType: string | undefined,
): string {
  const visualType = kind === "audio" || kind === "video" ? kind : attachmentVisualType(label, mimeType);
  return `chat-assistant-attachment-card__icon--${visualType}`;
}

function renderAttachmentIcon(options: {
  kind: AttachmentCardKind;
  label: string;
  mimeType?: string;
  compact?: boolean;
}): TemplateResult {
  const icon = attachmentIcon(options.kind, options.label, options.mimeType);
  const iconClass = attachmentIconClass(options.kind, options.label, options.mimeType);
  if (!options.compact) {
    return html`<span class="chat-assistant-attachment-card__icon ${iconClass}" aria-hidden="true"
      >${icon}</span
    >`;
  }
  return html`<span
    class="chat-assistant-attachment-card__icon ${iconClass} chat-assistant-attachment-card__icon--tile"
    aria-hidden="true"
  >
    <span class="chat-assistant-attachment-card__icon-glyph">${icon}</span>
    <span class="chat-assistant-attachment-card__icon-label"
      >${attachmentFormatLabel(options.kind, options.label, options.mimeType)}</span
    >
  </span>`;
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
        ${renderAttachmentIcon(options)}
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
