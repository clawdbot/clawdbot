import { html, type TemplateResult } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import {
  renderAttachmentFileIcon,
  resolveAttachmentFileIcon,
  type AttachmentFileVisualMode,
} from "./chat-attachment-file-icon.ts";
import type { AttachmentItem } from "./chat-message-media.ts";

type AttachmentCardKind = Extract<
  AttachmentItem["attachment"]["kind"],
  "audio" | "document" | "image" | "video"
>;

export type AttachmentCardHeaderOptions = {
  kind: AttachmentCardKind;
  label: string;
  mimeType?: string;
  sizeBytes?: number;
  titleHref?: string;
  downloadHref?: string;
  onDownload?: () => void;
  showExpandAction?: boolean;
  onExpand?: () => void;
  visualMode?: AttachmentFileVisualMode;
  voiceNote?: boolean;
};

const attachmentCardInteractiveSelector =
  "a, button, input, select, textarea, audio, video, iframe, [contenteditable='true'], [tabindex], [role='button']";

export function openAttachmentCardFromClick(
  event: MouseEvent,
  onOpen: (() => void) | undefined,
): void {
  if (!onOpen || event.defaultPrevented) {
    return;
  }
  const target = event.target;
  const card = event.currentTarget;
  if (target instanceof Element && card instanceof Element) {
    const interactive = target.closest(attachmentCardInteractiveSelector);
    if (interactive && card.contains(interactive)) {
      return;
    }
  }
  onOpen();
}

function attachmentFormatLabel(
  label: string,
  mimeType: string | undefined,
): string {
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

export function renderAttachmentCardHeader(
  options: AttachmentCardHeaderOptions,
): TemplateResult {
  const compactPreview = options.visualMode === "preview-with-favicon";
  const compactSize =
    compactPreview && options.sizeBytes !== undefined
      ? formatBytes(options.sizeBytes)
      : undefined;
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
  const hasOpenAction = options.showExpandAction === true && options.onExpand !== undefined;
  const downloadClass = `chat-assistant-attachment-card__action chat-assistant-attachment-card__download chat-assistant-attachment-card__download--ghost ${hasOpenAction
    ? "chat-assistant-attachment-card__download--secondary"
    : ""}`;
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
              ? html`<span
                    class="chat-assistant-attachment-card__separator"
                    aria-hidden="true"
                    >·</span
                  ><span class="chat-assistant-attachment-card__meta">${compactSize}</span>`
              : null
            : html`<span class="chat-assistant-attachment-card__meta">${metadata}</span>`}
        </span>
      </div>
      <span class="chat-assistant-attachment-card__actions">
        ${options.voiceNote && !compactPreview
          ? html`<span class="chat-assistant-attachment-badge"
              >${t("chat.messages.voiceNote")}</span
            >`
          : null}
        ${options.downloadHref
          ? html`<a
              class=${downloadClass}
              href=${options.downloadHref}
              download=${options.label}
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
                >${icons.download}</button
              >`
            : null}
        ${hasOpenAction
          ? html`<button
              type="button"
              class="chat-assistant-attachment-card__action ${compactPreview
                ? "chat-assistant-attachment-card__expand--icon"
                : "chat-assistant-attachment-card__action--labeled"} chat-assistant-attachment-card__expand"
              aria-label=${t("chat.attachments.expand", { filename: options.label })}
              title=${t("chat.attachments.expand", { filename: options.label })}
              @click=${options.onExpand}
              >${compactPreview
                ? icons.chevronsUpDown
                : html`<span>${t("chat.attachments.open")}</span>`}</button
            >`
          : null}
      </span>
    </div>
  `;
}
