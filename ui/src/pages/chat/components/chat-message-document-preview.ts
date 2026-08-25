import { html } from "lit";
import { t } from "../../../i18n/index.ts";
import { getMediaFileExtension } from "../../../lib/media-file-extension.ts";
import {
  isChatMediaResourceCurrent,
  notifyChatMediaResourceSubscribers,
  observeChatMediaResource,
  type AttachmentItem,
} from "./chat-message-media.ts";

const DOCUMENT_PREVIEW_MAX_BYTES = 256 * 1024;
const DOCUMENT_PREVIEW_MAX_CHARS = 16 * 1024;
const DOCUMENT_PREVIEW_MAX_ROWS = 8;
const DOCUMENT_PREVIEW_MAX_COLUMNS = 24;
const DOCUMENT_PREVIEW_MAX_CELLS = 128;
const DOCUMENT_PREVIEW_VISIBLE_ROWS = 4;
const DOCUMENT_PREVIEW_VISIBLE_COLUMNS = 8;
const DOCUMENT_PREVIEW_FETCH_TIMEOUT_MS = 10_000;
export type DocumentFramePreviewState = "failed" | "loading" | "ready" | undefined;
export type AttachmentDocumentPreviewKind = "html" | "page" | "table" | null;

export function resolveDocumentPreviewKind(
  attachment: Pick<AttachmentItem["attachment"], "label" | "mimeType">,
): AttachmentDocumentPreviewKind {
  const extension = getMediaFileExtension(attachment.label);
  const mimeType = attachment.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (extension === "html" || extension === "htm" || mimeType === "text/html") {
    return "html";
  }
  if (
    extension === "csv" ||
    extension === "tsv" ||
    mimeType === "text/csv" ||
    mimeType === "text/tab-separated-values"
  ) {
    return "table";
  }
  if (extension === "pdf" || mimeType === "application/pdf") {
    return "page";
  }
  return null;
}

export type DelimitedPreview = {
  rows: string[][];
  truncated: boolean;
};

export function parseDelimitedPreview(text: string, delimiter: "," | "\t" = ","): DelimitedPreview {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let cellCount = 0;
  let quoted = false;
  let truncated = false;
  const commitCell = () => {
    if (row.length < DOCUMENT_PREVIEW_MAX_COLUMNS && cellCount < DOCUMENT_PREVIEW_MAX_CELLS) {
      row.push(cell.trim());
      cellCount += 1;
    } else {
      truncated = true;
    }
    cell = "";
  };
  const commitRow = () => {
    commitCell();
    if (row.some((value) => value.length > 0)) {
      rows.push(row);
    }
    row = [];
  };
  let index = 0;
  for (; index < text.length && rows.length < DOCUMENT_PREVIEW_MAX_ROWS; index += 1) {
    if (cellCount >= DOCUMENT_PREVIEW_MAX_CELLS) {
      break;
    }
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        if (row.length < DOCUMENT_PREVIEW_MAX_COLUMNS) {
          cell += '"';
        }
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && character === delimiter) {
      commitCell();
      continue;
    }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      commitRow();
      continue;
    }
    if (row.length < DOCUMENT_PREVIEW_MAX_COLUMNS) {
      cell += character;
    }
  }
  if (index < text.length) {
    truncated = true;
  }
  if ((cell.length > 0 || row.length > 0) && rows.length < DOCUMENT_PREVIEW_MAX_ROWS) {
    commitRow();
  }
  return { rows, truncated };
}

export function parseAttachmentDelimitedPreview(
  text: string,
  attachment: Pick<AttachmentItem["attachment"], "label" | "mimeType">,
): DelimitedPreview {
  const extension = getMediaFileExtension(attachment.label);
  const mimeType = attachment.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return parseDelimitedPreview(
    text,
    extension === "tsv" || mimeType === "text/tab-separated-values" ? "\t" : ",",
  );
}

async function probeDocumentPreview(source: string, signal: AbortSignal): Promise<boolean> {
  const url = source.replace(/#.*$/u, "");
  // Iframes report many HTTP failures as load events. Probe after explicit
  // interaction, and cancel the GET fallback before it buffers the document.
  let response = await fetch(url, {
    credentials: "same-origin",
    method: "HEAD",
    signal,
  });
  if (response.status === 405 || response.status === 501) {
    response = await fetch(url, {
      credentials: "same-origin",
      method: "GET",
      signal,
    });
  }
  await response.body?.cancel().catch(() => undefined);
  return response.ok;
}

export function resolveDocumentFramePreviewState(
  attachmentUrl: string,
  sourceIdentity: string,
  onRequestUpdate: (() => void) | undefined,
): DocumentFramePreviewState {
  return observeChatMediaResource<DocumentFramePreviewState>(
    "document-frame",
    attachmentUrl,
    onRequestUpdate,
    sourceIdentity,
  ).value;
}

function requestDocumentFramePreview(
  event: Event,
  source: string,
  sourceIdentity: string,
  onRequestUpdate: (() => void) | undefined,
): void {
  event.stopPropagation();
  const trigger = event.currentTarget;
  if (!(trigger instanceof HTMLButtonElement)) {
    return;
  }
  const cacheKey = source.replace(/#.*$/u, "");
  const resource = observeChatMediaResource<DocumentFramePreviewState>(
    "document-frame",
    cacheKey,
    onRequestUpdate,
    sourceIdentity,
  );
  if (resource.pending || resource.value === "loading" || resource.value === "ready") {
    return;
  }
  resource.value = "loading";
  notifyChatMediaResourceSubscribers(resource);
  const controller = new AbortController();
  resource.abortController = controller;
  const timeout = setTimeout(
    () => controller.abort(new DOMException("document preview probe timed out", "TimeoutError")),
    DOCUMENT_PREVIEW_FETCH_TIMEOUT_MS,
  );
  const pending = probeDocumentPreview(source, controller.signal)
    .then((available) => {
      if (!isChatMediaResourceCurrent(resource)) {
        return null;
      }
      resource.value = available ? "ready" : "failed";
      return resource.value;
    })
    .catch(() => {
      if (isChatMediaResourceCurrent(resource)) {
        resource.value = "failed";
      }
      return null;
    })
    .finally(() => {
      clearTimeout(timeout);
      if (resource.abortController === controller) {
        resource.abortController = undefined;
      }
      if (resource.pending === pending) {
        resource.pending = undefined;
      }
      notifyChatMediaResourceSubscribers(resource);
    });
  resource.pending = pending;
}

function renderAttachmentTablePreview(
  attachment: AttachmentItem["attachment"],
  previewText: string | null | undefined,
) {
  if (previewText === undefined) {
    return html`<div class="chat-assistant-attachment-card__preview-unavailable">
      ${t("chat.mediaPlayer.preparing")}
    </div>`;
  }
  const preview = previewText
    ? parseAttachmentDelimitedPreview(previewText, attachment)
    : { rows: [], truncated: false };
  const { rows } = preview;
  if (rows.length === 0) {
    return html`<div class="chat-assistant-attachment-card__preview-unavailable">
      ${t("chat.attachments.previewUnavailable")}
    </div>`;
  }
  const columnCount = Math.max(...rows.map((row) => row.length));
  const visibleColumnCount = Math.min(columnCount, DOCUMENT_PREVIEW_VISIBLE_COLUMNS);
  const visibleRows = rows.slice(0, DOCUMENT_PREVIEW_VISIBLE_ROWS);
  const alwaysTruncated =
    preview.truncated ||
    rows.length > DOCUMENT_PREVIEW_VISIBLE_ROWS ||
    columnCount > DOCUMENT_PREVIEW_VISIBLE_COLUMNS;
  const mediumTruncated = columnCount > 5;
  const narrowTruncated = columnCount > 3;
  return html`
    <div class="chat-assistant-attachment-card__table-wrap">
      <table class="chat-assistant-attachment-card__table">
        <thead>
          <tr>
            ${Array.from(
              { length: visibleColumnCount },
              (_, index) => html`<th title=${visibleRows[0]?.[index] ?? ""}>
                ${visibleRows[0]?.[index] ?? ""}
              </th>`,
            )}
          </tr>
        </thead>
        <tbody>
          ${visibleRows.slice(1).map(
            (row) => html`<tr>
              ${Array.from(
                { length: visibleColumnCount },
                (_, index) => html`<td title=${row[index] ?? ""}>${row[index] ?? ""}</td>`,
              )}
            </tr>`,
          )}
        </tbody>
      </table>
      ${alwaysTruncated || mediumTruncated || narrowTruncated
        ? html`<div
            class="chat-assistant-attachment-card__table-truncated"
            role="note"
            ?data-always-truncated=${alwaysTruncated}
            ?data-medium-truncated=${mediumTruncated}
            ?data-narrow-truncated=${narrowTruncated}
          >
            ${t("chat.attachments.previewTruncated")}
          </div>`
        : null}
    </div>
  `;
}

export function renderAttachmentDocumentPreview(
  previewKind: Exclude<AttachmentDocumentPreviewKind, null>,
  attachment: AttachmentItem["attachment"],
  attachmentUrl: string,
  previewText: string | null | undefined,
  framePreviewState: DocumentFramePreviewState,
  onRequestUpdate: (() => void) | undefined,
) {
  if (previewKind === "html") {
    return html`<div class="chat-assistant-attachment-card__html-preview">
      ${framePreviewState === "ready"
        ? html`<iframe
            src=${attachmentUrl}
            title=${attachment.label}
            sandbox=""
            loading="lazy"
            scrolling="no"
          ></iframe>`
        : framePreviewState === "loading"
          ? html`<div class="chat-assistant-attachment-card__preview-unavailable">
              ${t("chat.mediaPlayer.preparing")}
            </div>`
          : html`<button
              type="button"
              class="chat-assistant-attachment-card__preview-load"
              @click=${(event: Event) =>
                requestDocumentFramePreview(event, attachmentUrl, attachment.url, onRequestUpdate)}
            >
              ${t("chat.attachments.loadPreview")}
            </button>`}
      <span class="chat-assistant-attachment-card__preview-fade" aria-hidden="true"></span>
    </div>`;
  }
  if (previewKind === "table") {
    return renderAttachmentTablePreview(attachment, previewText);
  }
  const previewUrl = `${attachmentUrl.split("#", 1)[0]}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`;
  return html`<div class="chat-assistant-attachment-card__page-preview">
    ${framePreviewState === "ready"
      ? html`<iframe
          src=${previewUrl}
          title=${attachment.label}
          sandbox="allow-scripts"
          loading="lazy"
        ></iframe>`
      : framePreviewState === "loading"
        ? html`<div class="chat-assistant-attachment-card__preview-unavailable">
            ${t("chat.mediaPlayer.preparing")}
          </div>`
        : html`<button
            type="button"
            class="chat-assistant-attachment-card__preview-load"
            @click=${(event: Event) =>
              requestDocumentFramePreview(event, previewUrl, attachment.url, onRequestUpdate)}
          >
            ${t("chat.attachments.loadPreview")}
          </button>`}
  </div>`;
}

function capPreviewText(text: string): string {
  return text.length > DOCUMENT_PREVIEW_MAX_CHARS
    ? `${text.slice(0, DOCUMENT_PREVIEW_MAX_CHARS)}…`
    : text;
}

// Reads at most the preview budget from the body and cancels the rest so an
// unknown-size or endless text attachment cannot buffer fully just by rendering.
async function readBoundedPreviewText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return capPreviewText(await response.text());
  }
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length <= DOCUMENT_PREVIEW_MAX_CHARS) {
      const { done, value } = await reader.read();
      if (done) {
        return capPreviewText(text + decoder.decode());
      }
      // Slice before decoding: a blob/misbehaving source can deliver one giant
      // chunk, and UTF-8 spends at most 4 bytes per char, so this byte budget
      // still yields enough chars to exit the loop. A partial trailing code
      // point stays pending in the decoder and is discarded with the cancel.
      const remainingChars = DOCUMENT_PREVIEW_MAX_CHARS + 1 - text.length;
      const bounded =
        value.byteLength > remainingChars * 4 ? value.subarray(0, remainingChars * 4) : value;
      text += decoder.decode(bounded, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return capPreviewText(text);
}

export function resolveDocumentPreviewText(
  attachmentUrl: string,
  sourceIdentity: string,
  sizeBytes: number | undefined,
  onRequestUpdate: (() => void) | undefined,
): string | null | undefined {
  if (sizeBytes !== undefined && sizeBytes > DOCUMENT_PREVIEW_MAX_BYTES) {
    return null;
  }
  const resource = observeChatMediaResource<string | null>(
    "document-preview",
    attachmentUrl,
    onRequestUpdate,
    sourceIdentity,
  );
  if (resource.value !== undefined) {
    return resource.value;
  }
  if (resource.pending) {
    return undefined;
  }

  const controller = new AbortController();
  resource.abortController = controller;
  const timeout = setTimeout(
    () => controller.abort(new DOMException("document preview fetch timed out", "TimeoutError")),
    DOCUMENT_PREVIEW_FETCH_TIMEOUT_MS,
  );
  const pending = fetch(attachmentUrl, {
    credentials: "same-origin",
    method: "GET",
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!isChatMediaResourceCurrent(resource)) {
        return null;
      }
      if (!response.ok) {
        resource.value = null;
        return null;
      }
      const preview = await readBoundedPreviewText(response);
      if (!isChatMediaResourceCurrent(resource)) {
        return null;
      }
      resource.value = preview;
      return preview;
    })
    .catch(() => {
      if (isChatMediaResourceCurrent(resource)) {
        resource.value = null;
      }
      return null;
    })
    .finally(() => {
      clearTimeout(timeout);
      if (resource.abortController === controller) {
        resource.abortController = undefined;
      }
      if (resource.pending === pending) {
        resource.pending = undefined;
      }
      notifyChatMediaResourceSubscribers(resource);
    });
  resource.pending = pending;
  return undefined;
}
