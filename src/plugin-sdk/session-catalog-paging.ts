import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeBoundedOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionCatalogTranscriptItem } from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";

/** Keep a host's publication owned until its callback finishes, even after a fail-soft list. */
export function publishSessionCatalogHost<T>(
  params: {
    onHost?: (host: T) => void;
    waitUntil?: (completion: Promise<void>) => void;
  },
  pendingHost: Promise<T>,
): void {
  const { onHost, waitUntil } = params;
  const published = pendingHost.then((host) => onHost?.(host));
  // Observe rejection before registration: a closed owner may reject this handoff synchronously.
  void published.catch(() => undefined);
  waitUntil?.(published);
}

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
const MAX_CURSOR_LENGTH = 128;
const MAX_TRANSCRIPT_ITEM_BYTES = 512 * 1024;
const MAX_TRANSCRIPT_PAGE_BYTES = 20 * 1024 * 1024;

type SessionCatalogParameterMessages = {
  listNotObject: string;
  unknownListParameter: (key: string) => string;
  invalidSearchTerm: string;
  readNotObject: string;
  unknownReadParameter: (key: string) => string;
  invalidThreadId: string;
};

type SessionCatalogListParams = {
  searchTerm?: string;
  limit: number;
  cursor?: string;
};

type SessionCatalogReadParams = {
  threadId: string;
  limit: number;
  cursor?: string;
};

function boundedSessionCatalogLimit(value: unknown, fallback = DEFAULT_PAGE_LIMIT): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_PAGE_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${String(MAX_PAGE_LIMIT)}`);
  }
  return Number(value);
}

function encodeSessionCatalogCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function optionalSessionCatalogCursor(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    throw new Error("cursor is invalid");
  }
  return value;
}

function parseSessionCatalogListParams(
  value: unknown,
  options: {
    searchMaxLength: number;
    messages: SessionCatalogParameterMessages;
  },
): SessionCatalogListParams {
  if (value === undefined || value === null) {
    return { limit: DEFAULT_PAGE_LIMIT };
  }
  if (!isRecord(value)) {
    throw new Error(options.messages.listNotObject);
  }
  const unknown = Object.keys(value).find(
    (key) => !["searchTerm", "limit", "cursor"].includes(key),
  );
  if (unknown) {
    throw new Error(options.messages.unknownListParameter(unknown));
  }
  const searchTerm = normalizeBoundedOptionalString(value.searchTerm, options.searchMaxLength);
  if (value.searchTerm !== undefined && !searchTerm) {
    throw new Error(options.messages.invalidSearchTerm);
  }
  const cursor = optionalSessionCatalogCursor(value.cursor);
  return {
    limit: boundedSessionCatalogLimit(value.limit),
    ...(searchTerm ? { searchTerm } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

function parseSessionCatalogReadParams(
  value: unknown,
  options: {
    threadIdMaxLength: number;
    threadIdPattern: RegExp;
    messages: SessionCatalogParameterMessages;
  },
): SessionCatalogReadParams {
  if (!isRecord(value)) {
    throw new Error(options.messages.readNotObject);
  }
  const unknown = Object.keys(value).find((key) => !["threadId", "limit", "cursor"].includes(key));
  if (unknown) {
    throw new Error(options.messages.unknownReadParameter(unknown));
  }
  const threadId = normalizeBoundedOptionalString(value.threadId, options.threadIdMaxLength);
  if (!threadId || !options.threadIdPattern.test(threadId)) {
    throw new Error(options.messages.invalidThreadId);
  }
  const cursor = optionalSessionCatalogCursor(value.cursor);
  return {
    threadId,
    limit: boundedSessionCatalogLimit(value.limit),
    ...(cursor ? { cursor } : {}),
  };
}

function decodeSessionCatalogCursor(value: unknown): number {
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

function isExactSessionCatalogCursor(value: unknown): value is string {
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

/** Page chronological source items newest-first, bounding per-item and per-page byte budgets. */
function boundSessionCatalogTranscriptPage(
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
    page.push(bounded);
    pageBytes += itemBytes;
  }
  const consumed = offset + page.length;
  return {
    items: page,
    ...(consumed < items.length ? { nextCursor: encodeSessionCatalogCursor(consumed) } : {}),
  };
}

/** Canonical bounded parameter, base64url cursor, and UTF-8 transcript paging contract. */
export const sessionCatalogPaging = {
  boundedLimit: boundedSessionCatalogLimit,
  encodeCursor: encodeSessionCatalogCursor,
  optionalCursor: optionalSessionCatalogCursor,
  parseListParams: parseSessionCatalogListParams,
  parseReadParams: parseSessionCatalogReadParams,
  decodeCursor: decodeSessionCatalogCursor,
  isExactCursor: isExactSessionCatalogCursor,
  boundTranscriptPage: boundSessionCatalogTranscriptPage,
} as const;
