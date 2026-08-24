import {
  isChatMediaResourceCurrent,
  notifyChatMediaResourceSubscribers,
  observeChatMediaResource,
  type AttachmentItem,
} from "./chat-message-media.ts";
import { getMediaFileExtension } from "../../../lib/media-file-extension.ts";

const DOCUMENT_PREVIEW_MAX_BYTES = 256 * 1024;
const DOCUMENT_PREVIEW_MAX_CHARS = 16 * 1024;
const DOCUMENT_PREVIEW_MAX_ROWS = 8;
const DOCUMENT_PREVIEW_MAX_COLUMNS = 24;
const DOCUMENT_PREVIEW_MAX_CELLS = 128;
const DOCUMENT_PREVIEW_FETCH_TIMEOUT_MS = 10_000;
const TEXTY_DOCUMENT_MIME_TYPES = new Set([
  "application/json",
  "application/toml",
  "application/x-ndjson",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
]);
const TEXTY_DOCUMENT_EXTENSIONS = new Set([
  ".csv",
  ".diff",
  ".json",
  ".jsonl",
  ".log",
  ".markdown",
  ".md",
  ".patch",
  ".toml",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export function isTextyDocumentAttachment(
  attachment: Pick<AttachmentItem["attachment"], "label" | "mimeType">,
): boolean {
  const mimeType = attachment.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mimeType.startsWith("text/") || TEXTY_DOCUMENT_MIME_TYPES.has(mimeType)) {
    return true;
  }
  if (mimeType && mimeType !== "application/octet-stream") {
    return false;
  }
  const label = attachment.label.trim().toLowerCase();
  return [...TEXTY_DOCUMENT_EXTENSIONS].some((extension) => label.endsWith(extension));
}

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

export function parseDelimitedPreview(text: string): string[][] {
  const delimiter = text.includes("\t") && !text.includes(",") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let cellCount = 0;
  let quoted = false;
  const commitCell = () => {
    if (row.length < DOCUMENT_PREVIEW_MAX_COLUMNS && cellCount < DOCUMENT_PREVIEW_MAX_CELLS) {
      row.push(cell.trim());
      cellCount += 1;
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
  for (
    let index = 0;
    index < text.length &&
    rows.length < DOCUMENT_PREVIEW_MAX_ROWS &&
    cellCount < DOCUMENT_PREVIEW_MAX_CELLS;
    index += 1
  ) {
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
  if (
    (cell.length > 0 || row.length > 0) &&
    rows.length < DOCUMENT_PREVIEW_MAX_ROWS
  ) {
    commitRow();
  }
  return rows;
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
