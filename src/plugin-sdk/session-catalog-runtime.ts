// Private runtime helpers for registered session catalogs.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionCatalogTranscriptItem } from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";

export { buildControlUiCatalogSessionUrl } from "../../packages/session-url-contract/src/index.js";
export {
  listActiveSessionCatalogs,
  type ActiveSessionCatalog,
} from "../plugins/session-catalog-active.js";

// Offset-cursor paging scaffolding shared by local session catalog providers.
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
const MAX_CURSOR_LENGTH = 128;
const MAX_TRANSCRIPT_ITEM_BYTES = 512 * 1024;
const MAX_TRANSCRIPT_PAGE_BYTES = 20 * 1024 * 1024;

export function boundedSessionCatalogLimit(value: unknown, fallback = DEFAULT_PAGE_LIMIT): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_PAGE_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${String(MAX_PAGE_LIMIT)}`);
  }
  return Number(value);
}

export function encodeSessionCatalogCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function optionalSessionCatalogCursor(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    throw new Error("cursor is invalid");
  }
  return value;
}

export function decodeSessionCatalogCursor(value: unknown): number {
  const cursor = optionalSessionCatalogCursor(value);
  if (cursor === undefined) {
    return 0;
  }
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) {
      throw new Error("non-canonical base64url");
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!isRecord(parsed) || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) {
      throw new Error("invalid offset");
    }
    const offset = Number(parsed.offset);
    if (encodeSessionCatalogCursor(offset) !== cursor) {
      throw new Error("non-canonical cursor payload");
    }
    return offset;
  } catch (error) {
    throw new Error("cursor is invalid", { cause: error });
  }
}

export function isExactSessionCatalogCursor(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    decodeSessionCatalogCursor(value);
    return true;
  } catch {
    return false;
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes - 3) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const end = low > 0 && /[\uD800-\uDBFF]/u.test(text.charAt(low - 1)) ? low - 1 : low;
  return `${text.slice(0, end)}…`;
}

/** Page transcript items from the tail, bounding per-item and per-page byte budgets. */
export function boundSessionCatalogTranscriptPage(
  items: SessionCatalogTranscriptItem[],
  limit: number,
  offset: number,
): { items: SessionCatalogTranscriptItem[]; nextCursor?: string } {
  const end = Math.max(0, items.length - offset);
  const start = Math.max(0, end - limit);
  const page: SessionCatalogTranscriptItem[] = [];
  let pageBytes = 2;
  for (let index = end - 1; index >= start; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }
    const bounded: SessionCatalogTranscriptItem = {
      ...item,
      text: truncateUtf8(item.text ?? "", MAX_TRANSCRIPT_ITEM_BYTES),
    };
    const itemBytes = Buffer.byteLength(JSON.stringify(bounded), "utf8") + 1;
    if (page.length > 0 && pageBytes + itemBytes > MAX_TRANSCRIPT_PAGE_BYTES) {
      break;
    }
    page.unshift(bounded);
    pageBytes += itemBytes;
  }
  const consumed = offset + page.length;
  return {
    items: page,
    ...(consumed < items.length ? { nextCursor: encodeSessionCatalogCursor(consumed) } : {}),
  };
}
