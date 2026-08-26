import { html } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";

type AttachmentFileKind =
  | "archive"
  | "audio"
  | "code"
  | "generic"
  | "pdf"
  | "presentation"
  | "spreadsheet"
  | "text"
  | "video"
  | "word";

function attachmentFilePresentation(attachment: ChatAttachment): {
  icon: (typeof icons)[keyof typeof icons];
  kind: AttachmentFileKind;
  typeLabel: string;
} {
  const mimeType = attachment.mimeType.toLowerCase();
  const extension = attachment.fileName?.toLowerCase().split(".").pop() ?? "";
  const typeLabel = extension.toUpperCase() || t("chat.attachments.attachedFile");
  if (mimeType === "application/pdf" || extension === "pdf") {
    return { icon: icons.fileText, kind: "pdf", typeLabel };
  }
  if (mimeType.startsWith("audio/")) {
    return { icon: icons.music, kind: "audio", typeLabel };
  }
  if (mimeType.startsWith("video/")) {
    return { icon: icons.play, kind: "video", typeLabel };
  }
  if (
    [
      "application/gzip",
      "application/vnd.rar",
      "application/x-7z-compressed",
      "application/zip",
    ].includes(mimeType) ||
    ["zip", "tar", "gz", "tgz", "rar", "7z"].includes(extension)
  ) {
    return { icon: icons.archive, kind: "archive", typeLabel };
  }
  if (
    [
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ].includes(mimeType) ||
    ["doc", "docx"].includes(extension)
  ) {
    return { icon: icons.fileText, kind: "word", typeLabel };
  }
  if (
    [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv",
    ].includes(mimeType) ||
    ["csv", "xls", "xlsx"].includes(extension)
  ) {
    return { icon: icons.file, kind: "spreadsheet", typeLabel };
  }
  if (
    [
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ].includes(mimeType) ||
    ["ppt", "pptx"].includes(extension)
  ) {
    return { icon: icons.file, kind: "presentation", typeLabel };
  }
  if (
    ["application/json", "application/toml", "application/yaml"].includes(mimeType) ||
    ["js", "jsx", "ts", "tsx", "json", "yaml", "yml", "toml", "sh"].includes(extension)
  ) {
    return { icon: icons.braces, kind: "code", typeLabel };
  }
  if (mimeType.startsWith("text/") || ["md", "txt", "rtf"].includes(extension)) {
    return { icon: icons.fileText, kind: "text", typeLabel };
  }
  return { icon: icons.file, kind: "generic", typeLabel };
}

export function renderStandardFileAttachment(attachment: ChatAttachment) {
  const presentation = attachmentFilePresentation(attachment);
  const label = attachment.fileName ?? t("chat.attachments.attachedFile");
  return html`
    <openclaw-tooltip .content=${label}>
      <div
        class="chat-attachment-file chat-attachment-file--${presentation.kind}"
        role="img"
        aria-label=${label}
      >
        <span class="chat-attachment-file__icon">${presentation.icon}</span>
        <span class="chat-attachment-file__body">
          <span class="chat-attachment-file__name">${label}</span>
          <span class="chat-attachment-file__type">${presentation.typeLabel}</span>
        </span>
      </div>
    </openclaw-tooltip>
  `;
}
