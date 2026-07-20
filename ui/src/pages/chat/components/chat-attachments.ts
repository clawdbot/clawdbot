// Shared attachment controls for chat and new-session composers.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "../attachment-payload-store.ts";

const CHAT_ATTACHMENT_ACCEPT =
  "image/*,audio/*,application/pdf,text/*,.csv,.json,.md,.txt,.zip," +
  ".doc,.docx,.xls,.xlsx,.ppt,.pptx";
const LARGE_PASTE_TEXT_THRESHOLD = 1000;
const LARGE_PASTE_TEXT_MIME_TYPE = "text/plain";
const LARGE_PASTE_TEXT_FILE_PREFIX = "pasted-text-";
const PASTED_TEXT_PREVIEW_MAX_LENGTH = 20;
const largePastedTextAttachments = new WeakSet<ChatAttachment>();
const pastedTextPreviews = new WeakMap<ChatAttachment, string>();

type ChatAttachmentControlsProps = {
  attachments?: ChatAttachment[];
  disabled?: boolean;
  getAttachments?: () => ChatAttachment[];
  draft?: string;
  getDraft?: () => string;
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  onDraftChange?: (next: string) => void;
  onPendingReadsChange?: (delta: 1 | -1) => void;
  onRequestUpdate?: () => void;
  readSignal?: AbortSignal;
};

export function isFileDrag(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}

const TEXT_ENTRY_INPUT_TYPES = new Set([
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

// Native text/URL drop insertion is only meaningful on controls that can
// actually accept it; anywhere else (disabled/readonly inputs, non-text
// controls like checkbox/range) an uncancelled URL drop navigates the app
// away and discards unsent drafts.
export function isEditableDropTarget(event: DragEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) {
    return false;
  }
  const editable = target.closest("textarea, input, [contenteditable]");
  if (editable instanceof HTMLInputElement) {
    return TEXT_ENTRY_INPUT_TYPES.has(editable.type) && !editable.disabled && !editable.readOnly;
  }
  if (editable instanceof HTMLTextAreaElement) {
    return !editable.disabled && !editable.readOnly;
  }
  return editable instanceof HTMLElement && editable.isContentEditable;
}

function currentAttachments(props: ChatAttachmentControlsProps): ChatAttachment[] {
  return props.getAttachments?.() ?? props.attachments ?? [];
}

function isSupportedChatAttachmentFile(file: Pick<File, "name" | "type">): boolean {
  if (file.type.startsWith("video/")) {
    return false;
  }
  return !/\.(?:avi|m4v|mov|mp4|mpeg|mpg|webm)$/i.test(file.name);
}

function clickComposerInput(target: HTMLElement, selector: string) {
  target.closest("details")?.removeAttribute("open");
  target
    .closest(".agent-chat__composer-shell, .new-session-page__composer")
    ?.querySelector<HTMLInputElement>(selector)
    ?.click();
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function chatAttachmentFromFile(file: File, dataUrl: string): ChatAttachment {
  const attachment = {
    id: generateAttachmentId(),
    mimeType: file.type || "application/octet-stream",
    fileName: file.name || undefined,
    sizeBytes: file.size,
  };
  return registerChatAttachmentPayload({ attachment, dataUrl, file });
}

export function isLargePastedTextAttachment(attachment: ChatAttachment): boolean {
  return largePastedTextAttachments.has(attachment);
}

function encodeTextAsDataUrl(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return `data:${LARGE_PASTE_TEXT_MIME_TYPE};base64,${btoa(chunks.join(""))}`;
}

function createLargePastedTextAttachment(text: string): ChatAttachment {
  const file = new File([text], `${LARGE_PASTE_TEXT_FILE_PREFIX}${Date.now()}.txt`, {
    type: LARGE_PASTE_TEXT_MIME_TYPE,
  });
  const attachment = chatAttachmentFromFile(file, encodeTextAsDataUrl(text));
  largePastedTextAttachments.add(attachment);
  const preview = compactPastedTextPreview(text);
  if (preview) {
    pastedTextPreviews.set(attachment, preview);
  }
  return attachment;
}

function readTextFromDataUrl(dataUrl: string): string | null {
  const match = /^data:([^,]*),(.*)$/s.exec(dataUrl);
  if (!match) {
    return null;
  }
  const metadata = match[1];
  const payload = match[2];
  if (metadata === undefined || payload === undefined) {
    return null;
  }
  if (metadata.toLowerCase().includes(";base64")) {
    try {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }
  try {
    return decodeURIComponent(payload.replace(/\+/g, "%20"));
  } catch {
    return null;
  }
}

function compactPastedTextPreview(text: string): string | null {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= PASTED_TEXT_PREVIEW_MAX_LENGTH) {
    return normalized;
  }
  return `${truncateUtf16Safe(normalized, PASTED_TEXT_PREVIEW_MAX_LENGTH).trimEnd()}...`;
}

function pastedTextPreview(attachment: ChatAttachment): string {
  return pastedTextPreviews.get(attachment) ?? attachment.fileName ?? "Attached file";
}

function appendPastedTextToDraft(draft: string, text: string): string {
  if (!draft.trim()) {
    return text;
  }
  return `${draft.replace(/\s+$/u, "")}\n\n${text}`;
}

function handleLargeTextPaste(e: ClipboardEvent, props: ChatAttachmentControlsProps): boolean {
  if (!props.onAttachmentsChange) {
    return false;
  }
  const text = e.clipboardData?.getData("text/plain");
  if (!text || text.length <= LARGE_PASTE_TEXT_THRESHOLD) {
    return false;
  }
  e.preventDefault();
  const attachment = createLargePastedTextAttachment(text);
  props.onAttachmentsChange([...currentAttachments(props), attachment]);
  return true;
}

function dataImageClipboardFile(
  dataUrl: string,
  baseName = "pasted-image",
): { file: File; dataUrl: string } | null {
  const match = /^\s*data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)\s*$/i.exec(dataUrl);
  if (!match) {
    return null;
  }
  const mimeType = match[1]?.toLowerCase();
  const base64Source = match[2];
  if (!mimeType || !base64Source) {
    return null;
  }
  if (!isSupportedChatAttachmentFile({ name: baseName, type: mimeType })) {
    return null;
  }
  const base64 = base64Source.replace(/\s+/g, "");
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "png";
    return {
      file: new File([bytes], `${baseName}.${extension}`, { type: mimeType }),
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
  } catch {
    return null;
  }
}

/** Builds a registered chat attachment from a base64 image data URL. */
export function chatAttachmentFromDataUrl(
  dataUrl: string,
  fileName: string,
): ChatAttachment | null {
  const baseName = fileName.replace(/\.[a-z0-9]+$/i, "") || "image";
  const parsed = dataImageClipboardFile(dataUrl, baseName);
  return parsed ? chatAttachmentFromFile(parsed.file, parsed.dataUrl) : null;
}

function readAttachmentFile(
  file: File,
  props: ChatAttachmentControlsProps,
): Promise<ChatAttachment | null> {
  if (props.readSignal?.aborted) {
    return Promise.resolve(null);
  }
  props.onPendingReadsChange?.(1);
  return new Promise((resolve) => {
    const reader = new FileReader();
    let settled = false;
    const finish = (attachment: ChatAttachment | null) => {
      if (settled) {
        return;
      }
      settled = true;
      props.readSignal?.removeEventListener("abort", abort);
      props.onPendingReadsChange?.(-1);
      resolve(attachment);
    };
    const abort = () => {
      reader.abort();
      finish(null);
    };
    props.readSignal?.addEventListener("abort", abort, { once: true });
    reader.addEventListener("error", () => finish(null), { once: true });
    reader.addEventListener("abort", () => finish(null), { once: true });
    reader.addEventListener(
      "load",
      () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : null;
        finish(
          dataUrl && !props.readSignal?.aborted ? chatAttachmentFromFile(file, dataUrl) : null,
        );
      },
      { once: true },
    );
    reader.readAsDataURL(file);
  });
}

async function appendAttachmentFiles(files: readonly File[], props: ChatAttachmentControlsProps) {
  const supported = files.filter(isSupportedChatAttachmentFile);
  if (!props.onAttachmentsChange || supported.length === 0) {
    return;
  }
  const additions = (
    await Promise.all(supported.map((file) => readAttachmentFile(file, props)))
  ).filter((attachment): attachment is ChatAttachment => attachment !== null);
  if (props.readSignal?.aborted) {
    for (const attachment of additions) {
      releaseChatAttachmentPayload(attachment.id);
    }
    return;
  }
  if (additions.length === 0) {
    return;
  }
  props.onAttachmentsChange([...currentAttachments(props), ...additions]);
}

export function handleChatAttachmentPaste(e: ClipboardEvent, props: ChatAttachmentControlsProps) {
  const items = e.clipboardData?.items;
  if (!items || !props.onAttachmentsChange) {
    return;
  }
  const imageFiles = Array.from(items)
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (imageFiles.length === 0) {
    const text = e.clipboardData?.getData("text/plain");
    const pasted = text ? dataImageClipboardFile(text) : null;
    if (!pasted) {
      handleLargeTextPaste(e, props);
      return;
    }
    e.preventDefault();
    props.onAttachmentsChange([
      ...currentAttachments(props),
      chatAttachmentFromFile(pasted.file, pasted.dataUrl),
    ]);
    return;
  }
  e.preventDefault();
  void appendAttachmentFiles(imageFiles, props);
}

function showPastedTextInComposer(att: ChatAttachment, props: ChatAttachmentControlsProps): void {
  const dataUrl = getChatAttachmentDataUrl(att);
  const text = dataUrl ? readTextFromDataUrl(dataUrl) : null;
  if (!text || !props.onDraftChange) {
    return;
  }
  const nextAttachments = currentAttachments(props).filter(
    (attachment) => attachment.id !== att.id,
  );
  releaseChatAttachmentPayload(att.id);
  props.onAttachmentsChange?.(nextAttachments);
  props.onDraftChange(appendPastedTextToDraft(props.getDraft?.() ?? props.draft ?? "", text));
  props.onRequestUpdate?.();
}

function handleChatAttachmentFileSelect(e: Event, props: ChatAttachmentControlsProps) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  void appendAttachmentFiles(files, props);
}

export function handleChatAttachmentDrop(e: DragEvent, props: ChatAttachmentControlsProps) {
  e.preventDefault();
  void appendAttachmentFiles([...(e.dataTransfer?.files ?? [])], props);
}

export function renderChatAttachmentInputs(props: ChatAttachmentControlsProps) {
  return html`
    <input
      type="file"
      accept=${CHAT_ATTACHMENT_ACCEPT}
      multiple
      class="agent-chat__file-input"
      ?disabled=${props.disabled}
      @change=${(event: Event) => {
        if (!props.disabled) {
          handleChatAttachmentFileSelect(event, props);
        }
      }}
    />
    <input
      type="file"
      accept="image/*"
      multiple
      class="agent-chat__photo-input"
      ?disabled=${props.disabled}
      @change=${(event: Event) => {
        if (!props.disabled) {
          handleChatAttachmentFileSelect(event, props);
        }
      }}
    />
    <input
      type="file"
      accept="image/*"
      capture="environment"
      class="agent-chat__camera-input"
      ?disabled=${props.disabled}
      @change=${(event: Event) => {
        if (!props.disabled) {
          handleChatAttachmentFileSelect(event, props);
        }
      }}
    />
  `;
}

export function renderChatAttachmentMenu(props: ChatAttachmentControlsProps) {
  return html`
    <wa-dropdown
      class="agent-chat__attach-menu"
      placement="top-start"
      aria-label=${t("chat.composer.addAttachment")}
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        const menu = event.currentTarget as HTMLElement;
        const selector =
          event.detail.item.value === "camera"
            ? ".agent-chat__camera-input"
            : event.detail.item.value === "photo"
              ? ".agent-chat__photo-input"
              : event.detail.item.value === "file"
                ? ".agent-chat__file-input"
                : null;
        if (selector) {
          clickComposerInput(menu, selector);
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="agent-chat__input-btn agent-chat__input-btn--attach"
        aria-label=${t("chat.composer.addAttachment")}
        ?disabled=${props.disabled}
        title=${t("chat.composer.addAttachment")}
        @pointerdown=${(event: PointerEvent) => {
          const composer = (event.currentTarget as HTMLElement)
            .closest(".agent-chat__composer-shell")
            ?.querySelector("textarea");
          if (document.activeElement === composer) {
            event.preventDefault();
          }
        }}
      >
        ${icons.plus}
      </button>
      <wa-dropdown-item class="agent-chat__attach-menu-option" value="camera">
        <span slot="icon" aria-hidden="true">${icons.camera}</span>
        <span>${t("chat.composer.takePhoto")}</span>
      </wa-dropdown-item>
      <wa-dropdown-item class="agent-chat__attach-menu-option" value="photo">
        <span slot="icon" aria-hidden="true">${icons.image}</span>
        <span>${t("chat.composer.attachPhoto")}</span>
      </wa-dropdown-item>
      <wa-dropdown-item class="agent-chat__attach-menu-option" value="file">
        <span slot="icon" aria-hidden="true">${icons.folder}</span>
        <span>${t("chat.composer.attachFileOption")}</span>
      </wa-dropdown-item>
    </wa-dropdown>
  `;
}

export function renderAttachmentPreview(props: ChatAttachmentControlsProps) {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-attachments-preview">
      ${attachments.map(
        (att) => html`
          <div
            class=${[
              "chat-attachment-thumb",
              att.mimeType.startsWith("image/") ? "" : "chat-attachment-thumb--file",
              isLargePastedTextAttachment(att) ? "chat-attachment-thumb--pasted-text" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            ${att.mimeType.startsWith("image/") && getChatAttachmentPreviewUrl(att)
              ? html`<img src=${getChatAttachmentPreviewUrl(att)!} alt="Attachment preview" />`
              : isLargePastedTextAttachment(att)
                ? html`
                    <div class="chat-attachment-file chat-attachment-file--pasted-text">
                      <span class="chat-attachment-file__icon">${icons.fileText}</span>
                      <span class="chat-attachment-file__body">
                        <span class="chat-attachment-file__name">${pastedTextPreview(att)}</span>
                        <button
                          class="chat-attachment-text-action"
                          type="button"
                          aria-label=${t("worktrees.restore")}
                          ?disabled=${props.disabled}
                          @click=${() => showPastedTextInComposer(att, props)}
                        >
                          ${t("worktrees.restore")}
                          <span aria-hidden="true">${icons.chevronRight}</span>
                        </button>
                      </span>
                    </div>
                  `
                : html`
                    <openclaw-tooltip .content=${att.fileName ?? "Attached file"}>
                      <div class="chat-attachment-file">
                        <span class="chat-attachment-file__icon">${icons.paperclip}</span>
                        <span class="chat-attachment-file__name"
                          >${att.fileName ?? "Attached file"}</span
                        >
                      </div>
                    </openclaw-tooltip>
                  `}
            <openclaw-tooltip .content=${t("chat.composer.removeAttachment")}>
              <button
                class="chat-attachment-remove"
                type="button"
                aria-label=${t("chat.composer.removeAttachment")}
                ?disabled=${props.disabled}
                @click=${() => {
                  const next = currentAttachments(props).filter((a) => a.id !== att.id);
                  releaseChatAttachmentPayload(att.id);
                  props.onAttachmentsChange?.(next);
                }}
              >
                ${icons.x}
              </button>
            </openclaw-tooltip>
          </div>
        `,
      )}
    </div>
  `;
}
