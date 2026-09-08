// Shared attachment controls for chat and new-session composers.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../../components/icons.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import "../../../components/tooltip.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import type { BrowserAnnotationAttachment, ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { showToast } from "../../../lib/toast.ts";
import {
  generateAttachmentId,
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import { admitAttachmentFiles } from "./chat-attachment-admission.ts";
import { resolveAttachmentFileIcon } from "./chat-attachment-file-icon.ts";
import { syncChatAttachmentRailScroll } from "./chat-attachment-viewport.ts";

const CHAT_ATTACHMENT_ACCEPT =
  "image/*,audio/*,video/*,application/pdf,text/*,.csv,.json,.md,.txt,.zip," +
  ".doc,.docx,.xls,.xlsx,.ppt,.pptx";
const LARGE_PASTE_TEXT_THRESHOLD = 1000;
const LARGE_PASTE_TEXT_MIME_TYPE = "text/plain";
const LARGE_PASTE_TEXT_FILE_PREFIX = "pasted-text-";
const PASTED_TEXT_PREVIEW_MAX_LENGTH = 20;
const largePastedTextAttachments = new WeakSet<ChatAttachment>();
const pastedTextPreviews = new WeakMap<ChatAttachment, string>();

export type ChatAttachmentControlsProps = {
  /** Decoded-size ceilings from hello policy; absent means no client-side cap. */
  attachmentLimits?: { maxBytes: number; maxImageBytes: number };
  attachments?: ChatAttachment[];
  disabled?: boolean;
  getAttachments?: () => ChatAttachment[];
  draft?: string;
  getDraft?: () => string;
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  onRemoveAttachment?: (attachment: ChatAttachment) => void;
  onDraftChange?: (next: string) => void;
  onPendingReadsChange?: (delta: 1 | -1) => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onRequestUpdate?: () => void;
  readSignal?: AbortSignal;
};

export class ChatAttachmentReadLifecycle {
  pendingReads = 0;
  private controller = new AbortController();

  constructor(private readonly notify: () => void) {}

  get readSignal(): AbortSignal {
    return this.controller.signal;
  }

  updatePending(readSignal: AbortSignal, delta: 1 | -1): void {
    if (this.controller.signal !== readSignal) {
      return;
    }
    this.pendingReads = Math.max(0, this.pendingReads + delta);
    this.notify();
  }

  abortReads(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.pendingReads = 0;
    this.notify();
  }
}

function isFileDrag(dataTransfer: DataTransfer | null): boolean {
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
function isEditableDropTarget(event: DragEvent): boolean {
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

function clickComposerInput(target: HTMLElement, selector: string) {
  target.closest("details")?.removeAttribute("open");
  target
    .closest(".agent-chat__composer-shell, .new-session-page__composer")
    ?.querySelector<HTMLInputElement>(selector)
    ?.click();
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

function createLargePastedTextAttachment(text: string, file: File): ChatAttachment {
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
  return (
    pastedTextPreviews.get(attachment) ?? attachment.fileName ?? t("chat.attachments.attachedFile")
  );
}

function renderCompactAttachmentFile(attachment: ChatAttachment) {
  const resolved = resolveAttachmentFileIcon(
    attachment.fileName ?? "attachment",
    attachment.mimeType,
  );
  const glyph =
    resolved.family === "video"
      ? icons.play
      : resolved.family === "audio"
        ? icons.music
        : icons.fileText;
  return html`
    <openclaw-tooltip .content=${attachment.fileName ?? t("chat.attachments.attachedFile")}>
      <div class="chat-attachment-file">
        <span class="chat-attachment-file__icon" data-family=${resolved.family}>${glyph}</span>
        <span class="chat-attachment-file__body">
          <span class="chat-attachment-file__name"
            >${attachment.fileName ?? t("chat.attachments.attachedFile")}</span
          >
          <span class="chat-attachment-file__type">${resolved.extensionLabel}</span>
        </span>
      </div>
    </openclaw-tooltip>
  `;
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
  const file = new File([text], `${LARGE_PASTE_TEXT_FILE_PREFIX}${Date.now()}.txt`, {
    type: LARGE_PASTE_TEXT_MIME_TYPE,
  });
  if (admitAttachmentFiles([file], props.attachmentLimits).length === 0) {
    // The rejection toast named the file; the clipboard still holds the text.
    return true;
  }
  const attachment = createLargePastedTextAttachment(text, file);
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
  limits?: ChatAttachmentControlsProps["attachmentLimits"],
): ChatAttachment | null {
  const baseName = fileName.replace(/\.[a-z0-9]+$/i, "") || "image";
  const parsed = dataImageClipboardFile(dataUrl, baseName);
  if (!parsed || admitAttachmentFiles([parsed.file], limits).length === 0) {
    return null;
  }
  return chatAttachmentFromFile(parsed.file, parsed.dataUrl);
}

function readAttachmentFile(
  file: File,
  props: ChatAttachmentControlsProps,
): Promise<ChatAttachment | null> {
  if (props.readSignal?.aborted) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    let settled = false;
    const finish = (attachment: ChatAttachment | null) => {
      if (settled) {
        return;
      }
      settled = true;
      props.readSignal?.removeEventListener("abort", abort);
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

async function appendAttachmentFiles(
  candidates: readonly File[],
  props: ChatAttachmentControlsProps,
) {
  if (!props.onAttachmentsChange || candidates.length === 0) {
    return;
  }
  const files = admitAttachmentFiles(candidates, props.attachmentLimits);
  if (files.length === 0) {
    return;
  }
  props.onPendingReadsChange?.(1);
  try {
    const results = await Promise.all(files.map((file) => readAttachmentFile(file, props)));
    const additions = results.filter(
      (attachment): attachment is ChatAttachment => attachment !== null,
    );
    if (props.readSignal?.aborted) {
      for (const attachment of additions) {
        releaseChatAttachmentPayload(attachment.id);
      }
      return;
    }
    // Unreadable drops (folders, permission-denied files) must not vanish
    // silently: name what was skipped so the user knows it never attached.
    const failed = results
      .map((attachment, index) => (attachment === null ? files[index]?.name : undefined))
      .filter((name): name is string => Boolean(name));
    if (failed.length > 0) {
      showToast({
        message: t("chat.attachments.readFailed", {
          names: failed.slice(0, 3).join(", "),
          more: failed.length > 3 ? ` +${failed.length - 3}` : "",
        }),
      });
    }
    if (additions.length === 0) {
      return;
    }
    // Keep the batch pending until its payloads are in the composer so an
    // immediate send cannot slip between FileReader completion and insertion.
    props.onAttachmentsChange([...currentAttachments(props), ...additions]);
  } finally {
    props.onPendingReadsChange?.(-1);
  }
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
    if (admitAttachmentFiles([pasted.file], props.attachmentLimits).length === 0) {
      return;
    }
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
  const input = e.target;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const files = [...(input.files ?? [])];
  input.value = "";
  void appendAttachmentFiles(files, props);
}

function handleChatAttachmentDrop(e: DragEvent, props: ChatAttachmentControlsProps) {
  e.preventDefault();
  void appendAttachmentFiles([...(e.dataTransfer?.files ?? [])], props);
}

type ChatAttachmentDropProps = ChatAttachmentControlsProps & {
  canCompose: boolean;
};

// Both composers share balanced nested drag state and cancel non-editable
// text/URL drops so disabled surfaces cannot navigate away from a draft.
export function createChatAttachmentDropHandlers(props: ChatAttachmentDropProps) {
  let depth = 0;
  const setActive = (event: DragEvent, active: boolean) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (active) {
      if (!props.canCompose || !isFileDrag(event.dataTransfer)) {
        return;
      }
      depth += 1;
    } else {
      depth = Math.max(0, depth - 1);
    }
    target.toggleAttribute("data-attachment-drop-active", depth > 0);
  };
  const clearActive = (event: DragEvent) => {
    depth = 0;
    const target = event.currentTarget;
    if (target instanceof HTMLElement) {
      target.removeAttribute("data-attachment-drop-active");
    }
  };
  return {
    onDragenter: (event: DragEvent) => setActive(event, true),
    onDragleave: (event: DragEvent) => setActive(event, false),
    onDragover: (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) {
        if (!isEditableDropTarget(event)) {
          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "none";
          }
        }
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = props.canCompose ? "copy" : "none";
      }
    },
    onDrop: (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) {
        if (!isEditableDropTarget(event)) {
          event.preventDefault();
        }
        return;
      }
      event.preventDefault();
      clearActive(event);
      if (props.canCompose) {
        handleChatAttachmentDrop(event, props);
      }
    },
  };
}

export function renderChatAttachmentInputs(props: ChatAttachmentControlsProps) {
  return html`
    ${(["file", "photo", "camera"] as const).map(
      (kind) => html`
        <input
          type="file"
          accept=${kind === "file" ? CHAT_ATTACHMENT_ACCEPT : "image/*"}
          ?multiple=${kind !== "camera"}
          capture=${kind === "camera" ? "environment" : nothing}
          class=${`agent-chat__${kind}-input`}
          ?disabled=${props.disabled}
          @change=${(event: Event) => {
            if (!props.disabled) {
              handleChatAttachmentFileSelect(event, props);
            }
          }}
        />
      `,
    )}
  `;
}

export function handleChatAttachmentMenuSelection(
  event: CustomEvent<{ item: { value?: string } }>,
): boolean {
  const value = event.detail.item.value;
  if (value !== "camera" && value !== "photo" && value !== "file") {
    return false;
  }
  const target = event.currentTarget;
  if (target instanceof HTMLElement) {
    clickComposerInput(target, `.agent-chat__${value}-input`);
  }
  return true;
}

export function renderChatAttachmentMenuTrigger(
  disabled: boolean | undefined,
  hasOverrides = false,
) {
  return html`
    <button
      slot="trigger"
      type="button"
      class="agent-chat__input-btn agent-chat__input-btn--attach ${
        hasOverrides ? "agent-chat__input-btn--has-overrides" : ""
      }"
      aria-label=${t("chat.composer.addAttachment")}
      ?disabled=${disabled}
      title=${t("chat.composer.addAttachment")}
    >
      ${icons.plus}
    </button>
  `;
}

export function renderChatAttachmentMenuOptions(fileIcon = icons.folder) {
  return html`
    <wa-dropdown-item class="agent-chat__attach-menu-option" value="camera">
      <span slot="icon" aria-hidden="true">${icons.camera}</span>
      <span>${t("chat.composer.takePhoto")}</span>
    </wa-dropdown-item>
    <wa-dropdown-item class="agent-chat__attach-menu-option" value="photo">
      <span slot="icon" aria-hidden="true">${icons.image}</span>
      <span>${t("chat.composer.attachPhoto")}</span>
    </wa-dropdown-item>
    <wa-dropdown-item class="agent-chat__attach-menu-option" value="file">
      <span slot="icon" aria-hidden="true">${fileIcon}</span>
      <span>${t("chat.composer.attachFileOption")}</span>
    </wa-dropdown-item>
  `;
}

function removeBrowserAnnotationAttachment(
  attachment: ChatAttachment,
  props: ChatAttachmentControlsProps,
): void {
  if (props.onRemoveAttachment) {
    props.onRemoveAttachment(attachment);
    return;
  }
  const next = currentAttachments(props).filter((candidate) => candidate.id !== attachment.id);
  releaseChatAttachmentPayload(attachment.id);
  props.onAttachmentsChange?.(next);
}

function renderAttachmentImage(
  attachment: ChatAttachment,
  alt: string,
  title: string,
  props: ChatAttachmentControlsProps,
): ReturnType<typeof html> | typeof nothing {
  const src = getChatAttachmentPreviewUrl(attachment);
  if (!src) {
    return nothing;
  }
  if (!props.onOpenImage) {
    return html`<img src=${src} alt=${alt} />`;
  }
  const open = () => props.onOpenImage?.({ src, title });
  return html`
    <button
      type="button"
      class="chat-message-image-button chat-attachment-image-button"
      aria-label=${t("chat.imageLightbox.open", { title })}
      @click=${open}
    >
      <img src=${src} alt=${alt} />
    </button>
  `;
}

function renderBrowserAnnotationAttachment(
  attachment: ChatAttachment,
  annotation: BrowserAnnotationAttachment,
  props: ChatAttachmentControlsProps,
) {
  const identity =
    annotation.title.trim() ||
    annotation.displayUrl.trim() ||
    attachment.fileName ||
    t("chat.attachments.attachedFile");
  const regionLabel = t(
    annotation.markedRegionCount === 1
      ? "chat.composer.browserAnnotationRegion"
      : "chat.composer.browserAnnotationRegions",
    { count: String(annotation.markedRegionCount) },
  );
  const removeLabel = t("chat.composer.removeBrowserAnnotation", { name: identity });

  return html`
    <div
      class="chat-attachment-thumb chat-attachment-thumb--browser-annotation"
      data-attachment-id=${attachment.id}
      role="group"
      aria-label=${`${t("chat.composer.browserAnnotation")}: ${identity}`}
    >
      <div class="chat-browser-annotation-card__preview">
        ${renderAttachmentImage(
          attachment,
          t("chat.composer.browserAnnotationPreview"),
          identity,
          props,
        )}
      </div>
      <div class="chat-attachment-file__body chat-browser-annotation-card__body">
        <span
          class="chat-attachment-file__name chat-browser-annotation-card__identity"
          title=${identity}
          >${identity}</span
        >
        <span class="chat-attachment-file__meta chat-browser-annotation-card__meta">
          <span>${regionLabel}</span>
        </span>
      </div>
      <openclaw-tooltip .content=${removeLabel}>
        <button
          class="chat-attachment-remove chat-browser-annotation-card__remove"
          type="button"
          aria-label=${removeLabel}
          ?disabled=${props.disabled}
          @click=${() => removeBrowserAnnotationAttachment(attachment, props)}
        >
          ${icons.x}
        </button>
      </openclaw-tooltip>
    </div>
  `;
}

export function renderAttachmentPreview(props: ChatAttachmentControlsProps) {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) {
    return nothing;
  }
  return html`
    <div
      class="chat-attachments-preview"
      ${ref(syncChatAttachmentRailScroll)}
      @scroll=${(event: Event) => {
        if (event.currentTarget instanceof Element) {
          syncChatAttachmentRailScroll(event.currentTarget);
        }
      }}
    >
      ${attachments.map((att) =>
        att.browserAnnotation
          ? renderBrowserAnnotationAttachment(att, att.browserAnnotation, props)
          : html`
              <div
                class=${[
                  "chat-attachment-thumb",
                  att.mimeType.startsWith("image/") ? "" : "chat-attachment-thumb--file",
                  isLargePastedTextAttachment(att) ? "chat-attachment-thumb--pasted-text" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                ${
                  att.mimeType.startsWith("image/") && getChatAttachmentPreviewUrl(att)
                    ? renderAttachmentImage(
                        att,
                        att.fileName?.trim() || t("chat.composer.attachmentPreview"),
                        att.fileName?.trim() || t("chat.imageLightbox.untitled"),
                        props,
                      )
                    : isLargePastedTextAttachment(att)
                      ? html`
                          <div class="chat-attachment-file chat-attachment-file--pasted-text">
                            <span class="chat-attachment-file__icon">${icons.fileText}</span>
                            <span class="chat-attachment-file__body">
                              <span class="chat-attachment-file__name"
                                >${pastedTextPreview(att)}</span
                              >
                              <button
                                class="chat-attachment-text-action"
                                type="button"
                                aria-label=${t("chat.attachments.showInTextField")}
                                ?disabled=${props.disabled}
                                @click=${() => showPastedTextInComposer(att, props)}
                              >
                                ${t("chat.attachments.showInTextField")}
                                <span aria-hidden="true">${icons.chevronRight}</span>
                              </button>
                            </span>
                          </div>
                        `
                      : renderCompactAttachmentFile(att)
                }
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
