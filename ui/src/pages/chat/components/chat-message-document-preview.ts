import { html } from "lit";
import { t } from "../../../i18n/index.ts";
import { getMediaFileExtension } from "../../../lib/media-file-extension.ts";
import {
  isChatMediaResourceCurrent,
  notifyChatMediaResourceSubscribers,
  observeChatMediaResource,
  type AttachmentItem,
} from "./chat-message-media.ts";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";

const DOCUMENT_PREVIEW_MAX_BYTES = 256 * 1024;
const DOCUMENT_PREVIEW_MAX_CHARS = 16 * 1024;
const DOCUMENT_PREVIEW_MAX_ROWS = 8;
const DOCUMENT_PREVIEW_MAX_COLUMNS = 24;
const DOCUMENT_PREVIEW_MAX_CELLS = 128;
const DOCUMENT_PREVIEW_VISIBLE_ROWS = 4;
const DOCUMENT_PREVIEW_VISIBLE_COLUMNS = 8;
const DOCUMENT_PANEL_MAX_ROWS = 4_096;
const DOCUMENT_PANEL_MAX_COLUMNS = 256;
const DOCUMENT_PANEL_MAX_CELLS = 4_096;
const DOCUMENT_PREVIEW_FETCH_TIMEOUT_MS = 10_000;
const HTML_PREVIEW_CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export type DocumentFramePreviewState = "failed" | "loading" | { src: string } | undefined;
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

type DelimitedPreviewLimits = {
  maxRows: number;
  maxColumns: number;
  maxCells: number;
};

const COMPACT_DELIMITED_PREVIEW_LIMITS: DelimitedPreviewLimits = {
  maxRows: DOCUMENT_PREVIEW_MAX_ROWS,
  maxColumns: DOCUMENT_PREVIEW_MAX_COLUMNS,
  maxCells: DOCUMENT_PREVIEW_MAX_CELLS,
};

const FULL_DELIMITED_PREVIEW_LIMITS: DelimitedPreviewLimits = {
  maxRows: DOCUMENT_PANEL_MAX_ROWS,
  maxColumns: DOCUMENT_PANEL_MAX_COLUMNS,
  maxCells: DOCUMENT_PANEL_MAX_CELLS,
};

function parseDelimitedPreview(
  text: string,
  delimiter: "," | "\t",
  limits: DelimitedPreviewLimits,
): DelimitedPreview {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let cellCount = 0;
  let quoted = false;
  let truncated = false;
  const commitCell = () => {
    if (row.length < limits.maxColumns && cellCount < limits.maxCells) {
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
  for (; index < text.length && rows.length < limits.maxRows; index += 1) {
    if (cellCount >= limits.maxCells) {
      break;
    }
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        if (row.length < limits.maxColumns) {
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
    if (row.length < limits.maxColumns) {
      cell += character;
    }
  }
  if (index < text.length) {
    truncated = true;
  }
  if ((cell.length > 0 || row.length > 0) && rows.length < limits.maxRows) {
    commitRow();
  }
  return { rows, truncated };
}

export function parseAttachmentDelimitedPreview(
  text: string,
  attachment: Pick<AttachmentItem["attachment"], "label" | "mimeType">,
): DelimitedPreview {
  return parseAttachmentDelimitedText(text, attachment, COMPACT_DELIMITED_PREVIEW_LIMITS);
}

function parseAttachmentDelimitedText(
  text: string,
  attachment: Pick<AttachmentItem["attachment"], "label" | "mimeType">,
  limits: DelimitedPreviewLimits,
): DelimitedPreview {
  const extension = getMediaFileExtension(attachment.label);
  const mimeType = attachment.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return parseDelimitedPreview(
    text,
    extension === "tsv" || mimeType === "text/tab-separated-values" ? "\t" : ",",
    limits,
  );
}

function blockHtmlPreviewNetwork(documentText: string): string {
  const parsed = new DOMParser().parseFromString(documentText, "text/html");
  const policy = parsed.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = HTML_PREVIEW_CONTENT_SECURITY_POLICY;
  parsed.head.prepend(policy);
  const doctype = parsed.doctype ? `<!DOCTYPE ${parsed.doctype.name}>` : "<!DOCTYPE html>";
  return `${doctype}\n${parsed.documentElement.outerHTML}`;
}

async function fetchDocumentPreviewObjectUrl(
  source: string,
  signal: AbortSignal,
  blockNetwork: boolean,
): Promise<string | null> {
  const url = source.replace(/#.*$/u, "");
  const response = await fetch(url, {
    credentials: "same-origin",
    method: "GET",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const bytes = await readResponseBytesWithinLimit(response, DOCUMENT_PREVIEW_MAX_BYTES);
  if (!bytes) {
    return null;
  }
  const contentType =
    response.headers.get("Content-Type")?.split(";", 1)[0]?.trim() ||
    (blockNetwork ? "text/html" : "application/octet-stream");
  const body = blockNetwork ? blockHtmlPreviewNetwork(new TextDecoder().decode(bytes)) : bytes;
  return URL.createObjectURL(new Blob([body], { type: contentType }));
}

function documentFramePreviewCacheKey(source: string, blockNetwork: boolean): string {
  return `${source.replace(/#.*$/u, "")}::${blockNetwork ? "network-blocked" : "native"}`;
}

export function resolveDocumentFramePreviewState(
  attachmentUrl: string,
  sourceIdentity: string,
  onRequestUpdate: (() => void) | undefined,
  blockNetwork = false,
  sizeBytes?: number,
): DocumentFramePreviewState {
  if (sizeBytes !== undefined && sizeBytes > DOCUMENT_PREVIEW_MAX_BYTES) {
    return "failed";
  }
  return observeChatMediaResource<DocumentFramePreviewState>(
    "document-frame",
    documentFramePreviewCacheKey(attachmentUrl, blockNetwork),
    onRequestUpdate,
    sourceIdentity,
  ).value;
}

function startDocumentFramePreview(
  source: string,
  sourceIdentity: string,
  onRequestUpdate: (() => void) | undefined,
  blockNetwork: boolean,
) {
  const cacheKey = documentFramePreviewCacheKey(source, blockNetwork);
  const resource = observeChatMediaResource<DocumentFramePreviewState>(
    "document-frame",
    cacheKey,
    onRequestUpdate,
    sourceIdentity,
  );
  if (resource.pending || resource.value !== undefined) {
    return resource;
  }
  resource.value = "loading";
  const controller = new AbortController();
  resource.abortController = controller;
  const timeout = setTimeout(
    () => controller.abort(new DOMException("document preview fetch timed out", "TimeoutError")),
    DOCUMENT_PREVIEW_FETCH_TIMEOUT_MS,
  );
  const pending = fetchDocumentPreviewObjectUrl(source, controller.signal, blockNetwork)
    .then((previewUrl) => {
      if (!isChatMediaResourceCurrent(resource)) {
        if (previewUrl) {
          URL.revokeObjectURL(previewUrl);
        }
        return null;
      }
      if (!previewUrl) {
        resource.value = "failed";
        return resource.value;
      }
      resource.value = { src: previewUrl };
      resource.dispose = () => URL.revokeObjectURL(previewUrl);
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
  return resource;
}

export function loadDocumentFramePreview(
  source: string,
  sourceIdentity: string,
  onRequestUpdate: (() => void) | undefined,
  blockNetwork = false,
  sizeBytes?: number,
): DocumentFramePreviewState {
  if (sizeBytes !== undefined && sizeBytes > DOCUMENT_PREVIEW_MAX_BYTES) {
    return "failed";
  }
  return startDocumentFramePreview(source, sourceIdentity, onRequestUpdate, blockNetwork).value;
}

function renderAttachmentTablePreview(
  attachment: AttachmentItem["attachment"],
  previewText: string | null | undefined,
  display: "compact" | "full",
) {
  if (previewText === undefined) {
    return html`<div class="chat-assistant-attachment-card__preview-unavailable">
      ${t("chat.mediaPlayer.preparing")}
    </div>`;
  }
  const preview = previewText
    ? parseAttachmentDelimitedText(
        previewText,
        attachment,
        display === "full" ? FULL_DELIMITED_PREVIEW_LIMITS : COMPACT_DELIMITED_PREVIEW_LIMITS,
      )
    : { rows: [], truncated: false };
  const { rows } = preview;
  if (rows.length === 0 || (display === "full" && preview.truncated)) {
    return html`<div class="chat-assistant-attachment-card__preview-unavailable">
      ${t("chat.attachments.previewUnavailable")}
    </div>`;
  }
  const columnCount = Math.max(...rows.map((row) => row.length));
  const visibleColumnCount =
    display === "full" ? columnCount : Math.min(columnCount, DOCUMENT_PREVIEW_VISIBLE_COLUMNS);
  const visibleRows = display === "full" ? rows : rows.slice(0, DOCUMENT_PREVIEW_VISIBLE_ROWS);
  const alwaysTruncated =
    preview.truncated ||
    rows.length > DOCUMENT_PREVIEW_VISIBLE_ROWS ||
    columnCount > DOCUMENT_PREVIEW_VISIBLE_COLUMNS;
  const bottomTruncated = preview.truncated || rows.length > DOCUMENT_PREVIEW_VISIBLE_ROWS;
  const mediumTruncated = columnCount > 5;
  const narrowTruncated = columnCount > 3;
  return html`
    <div
      class="chat-assistant-attachment-card__table-wrap"
      data-display=${display}
      ?data-right-truncated=${display === "compact" && alwaysTruncated}
      ?data-bottom-truncated=${display === "compact" && bottomTruncated}
      ?data-medium-truncated=${display === "compact" && mediumTruncated}
      ?data-narrow-truncated=${display === "compact" && narrowTruncated}
    >
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
    </div>
  `;
}

export function renderAttachmentDocumentPreview(
  previewKind: Exclude<AttachmentDocumentPreviewKind, null>,
  attachment: AttachmentItem["attachment"],
  attachmentUrl: string,
  previewText: string | null | undefined,
  framePreviewState: DocumentFramePreviewState,
  display: "compact" | "full" = "compact",
) {
  const frameSource = typeof framePreviewState === "object" ? framePreviewState.src : null;
  if (previewKind === "html") {
    return html`<div class="chat-assistant-attachment-card__html-preview">
      ${frameSource
        ? html`<iframe
            src=${frameSource}
            title=${attachment.label}
            sandbox=""
            loading="lazy"
            scrolling="no"
          ></iframe>`
        : framePreviewState === "loading"
          ? html`<div class="chat-assistant-attachment-card__preview-unavailable">
              ${t("chat.mediaPlayer.preparing")}
            </div>`
          : html`<div class="chat-assistant-attachment-card__preview-unavailable">
              ${t("chat.mediaPlayer.preparing")}
            </div>`}
      <span class="chat-assistant-attachment-card__preview-fade" aria-hidden="true"></span>
    </div>`;
  }
  if (previewKind === "table") {
    return renderAttachmentTablePreview(attachment, previewText, display);
  }
  const previewUrl = `${frameSource ?? attachmentUrl.split("#", 1)[0]}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`;
  return html`<div class="chat-assistant-attachment-card__page-preview">
    ${frameSource
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
        : html`<div class="chat-assistant-attachment-card__preview-unavailable">
            ${t("chat.mediaPlayer.preparing")}
          </div>`}
  </div>`;
}

function capPreviewText(text: string): string {
  return text.length > DOCUMENT_PREVIEW_MAX_CHARS
    ? `${text.slice(0, DOCUMENT_PREVIEW_MAX_CHARS)}…`
    : text;
}

async function readBoundedPreviewText(
  response: Response,
  display: "compact" | "full",
): Promise<string | null> {
  const bytes = await readResponseBytesWithinLimit(response, DOCUMENT_PREVIEW_MAX_BYTES);
  if (!bytes) {
    return null;
  }
  const text = new TextDecoder().decode(bytes);
  return display === "compact" ? capPreviewText(text) : text;
}

function observeDocumentPreviewText(
  attachmentUrl: string,
  sourceIdentity: string,
  onRequestUpdate: (() => void) | undefined,
  display: "compact" | "full",
) {
  return observeChatMediaResource<string | null>(
    "document-preview",
    `${attachmentUrl}::${display}`,
    onRequestUpdate,
    sourceIdentity,
  );
}

export function peekDocumentPreviewText(
  attachmentUrl: string,
  sourceIdentity: string,
  sizeBytes: number | undefined,
): string | null | undefined {
  if (sizeBytes !== undefined && sizeBytes > DOCUMENT_PREVIEW_MAX_BYTES) {
    return null;
  }
  return observeDocumentPreviewText(attachmentUrl, sourceIdentity, undefined, "compact").value;
}

export function resolveDocumentPreviewText(
  attachmentUrl: string,
  sourceIdentity: string,
  sizeBytes: number | undefined,
  onRequestUpdate: (() => void) | undefined,
  display: "compact" | "full" = "compact",
): string | null | undefined {
  if (sizeBytes !== undefined && sizeBytes > DOCUMENT_PREVIEW_MAX_BYTES) {
    return null;
  }
  const resource = observeDocumentPreviewText(
    attachmentUrl,
    sourceIdentity,
    onRequestUpdate,
    display,
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
      const preview = await readBoundedPreviewText(response, display);
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
