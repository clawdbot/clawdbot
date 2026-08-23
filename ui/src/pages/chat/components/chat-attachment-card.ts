import { html, type TemplateResult } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import {
  renderAttachmentFileIcon,
  resolveAttachmentFileIcon,
  type AttachmentFileVisualMode,
} from "./chat-attachment-file-icon.ts";
import { safeAttachmentHref } from "./chat-attachment-href.ts";
import type { AttachmentItem } from "./chat-message-media.ts";

type AttachmentCardKind = Extract<
  AttachmentItem["attachment"]["kind"],
  "audio" | "document" | "image" | "video"
>;

type AttachmentCardHeaderOptions = {
  kind: AttachmentCardKind;
  label: string;
  mimeType?: string;
  sizeBytes?: number;
  downloadHref?: string;
  onDownload?: () => void;
  onCopy?: () => void;
  showExpandAction?: boolean;
  onExpand?: () => void;
  visualMode?: AttachmentFileVisualMode;
  voiceNote?: boolean;
};

function attachmentFormatLabel(label: string, mimeType: string | undefined): string {
  return resolveAttachmentFileIcon(label, mimeType).extensionLabel;
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
  return attachmentFormatLabel(label, mimeType);
}

export function renderAttachmentCardIcon(options: {
  kind: AttachmentCardKind;
  label: string;
  mimeType?: string;
  visualMode?: AttachmentFileVisualMode;
  unavailable?: boolean;
}) {
  return renderAttachmentFileIcon({
    filename: options.label,
    mimeType: options.mimeType,
    mode: options.visualMode ?? "large-placeholder",
    unavailable: options.unavailable,
  });
}

export function renderAttachmentCardHeader(options: AttachmentCardHeaderOptions): TemplateResult {
  const compactPreview = options.visualMode === "preview-with-favicon";
  const compactSize =
    compactPreview && options.sizeBytes !== undefined ? formatBytes(options.sizeBytes) : undefined;
  const typeLabel = attachmentTypeLabel(options.kind, options.label, options.mimeType);
  const metadata = [
    typeLabel,
    options.sizeBytes !== undefined ? formatBytes(options.sizeBytes) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const title = html`<span class="chat-assistant-attachment-card__title" title=${options.label}
    >${options.label}</span
  >`;
  const downloadTitle = t("chat.mediaPlayer.download", { filename: options.label });
  const downloadHref = options.downloadHref ? safeAttachmentHref(options.downloadHref) : undefined;
  const hasOpenAction = options.showExpandAction === true && options.onExpand !== undefined;
  const downloadClass = `chat-assistant-attachment-card__action chat-assistant-attachment-card__download ${
    hasOpenAction ? "chat-assistant-attachment-card__download--secondary" : ""
  }`;
  return html`
    <div
      class="chat-assistant-attachment-card__header ${compactPreview
        ? "chat-assistant-attachment-card__header--preview"
        : ""}"
    >
      <div class="chat-assistant-attachment-card__identity">
        ${renderAttachmentCardIcon({
          kind: options.kind,
          label: options.label,
          mimeType: options.mimeType,
          visualMode: options.visualMode,
        })}
        <span
          class="chat-assistant-attachment-card__details ${compactPreview
            ? "chat-assistant-attachment-card__details--preview"
            : ""}"
        >
          ${title}
          ${compactPreview
            ? compactSize
              ? html`<span class="chat-assistant-attachment-card__separator" aria-hidden="true"
                    >·</span
                  ><span class="chat-assistant-attachment-card__meta">${compactSize}</span>`
              : null
            : html`<span class="chat-assistant-attachment-card__meta">${metadata}</span>`}
        </span>
      </div>
      <span class="chat-assistant-attachment-card__actions">
        ${options.voiceNote
          ? html`<span class="chat-assistant-attachment-badge"
              >${t("chat.messages.voiceNote")}</span
            >`
          : null}
        ${downloadHref
          ? html`<a
              class=${downloadClass}
              href=${downloadHref}
              download=${options.label}
              target="_blank"
              rel="noreferrer"
              aria-label=${downloadTitle}
              title=${downloadTitle}
              >${icons.download}</a
            >`
          : options.onDownload
            ? html`<button
                type="button"
                class=${downloadClass}
                aria-label=${downloadTitle}
                title=${downloadTitle}
                @click=${options.onDownload}
              >
                ${icons.download}
              </button>`
            : null}
        ${options.onCopy
          ? html`<button
              type="button"
              class="chat-assistant-attachment-card__action chat-assistant-attachment-card__copy"
              aria-label=${t("chat.imageLightbox.copy")}
              title=${t("chat.imageLightbox.copy")}
              @click=${options.onCopy}
            >
              ${icons.copy}
            </button>`
          : null}
        ${hasOpenAction
          ? html`<button
              type="button"
              class="chat-assistant-attachment-card__action chat-assistant-attachment-card__expand"
              aria-label=${t("chat.attachments.expand", { filename: options.label })}
              title=${t("chat.attachments.expand", { filename: options.label })}
              @click=${options.onExpand}
            >
              ${icons.arrowUpRight}
            </button>`
          : null}
      </span>
    </div>
  `;
}
