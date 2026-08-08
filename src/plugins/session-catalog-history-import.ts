import type {
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentMessage } from "../plugin-sdk/agent-core.js";
import { withSessionTranscriptWriteLock } from "../plugin-sdk/session-transcript-runtime.js";

const SESSION_CATALOG_HISTORY_IMPORT_MAX_ITEMS = 200;
const SESSION_CATALOG_HISTORY_IMPORT_MAX_BYTES = 512 * 1024;
const SESSION_CATALOG_HISTORY_IMPORT_PAGE_LIMIT = 100;
// Liveness bound for pathological providers: the item and byte caps only
// advance on retained items, so a provider that keeps answering with empty
// (or non-importable) pages and a fresh cursor would paginate forever. Count
// only consecutive empty pages so honest short-page providers (e.g. one item
// per page) still import their full history.
const SESSION_CATALOG_HISTORY_IMPORT_MAX_EMPTY_PAGES = 50;

function importedSessionCatalogMessage(params: {
  catalogId: string;
  item: SessionCatalogTranscriptItem;
  fallbackTimestamp: number;
}): AgentMessage | undefined {
  const parsedTimestamp = params.item.timestamp ? Date.parse(params.item.timestamp) : Number.NaN;
  const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : params.fallbackTimestamp;
  const importedText = params.item.text?.trim();
  if (!importedText && params.item.type === "reasoning") {
    return undefined;
  }
  const text = importedText || "[Unsupported catalog transcript item]";
  if (params.item.type === "userMessage") {
    // Imported native rows are not OpenClaw-authored; mirrorOrigin excludes them
    // from self-echo provenance so a repeated external prompt stays observable.
    return {
      role: "user",
      content: text,
      timestamp,
      __openclaw: { mirrorOrigin: `${params.catalogId}-catalog-import` },
    } as AgentMessage;
  }
  const prefix =
    params.item.type === "reasoning"
      ? "Thinking\n\n"
      : params.item.type === "toolCall"
        ? "Tool call\n\n"
        : params.item.type === "toolResult"
          ? "Tool result\n\n"
          : params.item.type === "other"
            ? "Other\n\n"
            : "";
  return {
    role: "assistant",
    content: [{ type: "text", text: `${prefix}${text}` }],
    timestamp,
    api: "openai-responses",
    provider: params.catalogId,
    model: params.item.model ?? "native-history",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  } as AgentMessage;
}

function fitSessionCatalogItemToBytes(
  item: SessionCatalogTranscriptItem,
  maxBytes: number,
): SessionCatalogTranscriptItem | undefined {
  if (Buffer.byteLength(JSON.stringify(item), "utf8") <= maxBytes) {
    return item;
  }
  const text = item.text;
  if (typeof text !== "string") {
    return undefined;
  }
  const candidate = (length: number): SessionCatalogTranscriptItem => {
    const safeLength =
      length > 0 && /[\uD800-\uDBFF]/u.test(text.charAt(length - 1)) ? length - 1 : length;
    return { ...item, text: `${text.slice(0, safeLength)}…`, truncated: true };
  };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(candidate(middle)), "utf8") <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const bounded = candidate(low);
  return Buffer.byteLength(JSON.stringify(bounded), "utf8") <= maxBytes ? bounded : undefined;
}

function importableSessionCatalogItem(
  item: SessionCatalogTranscriptItem,
): SessionCatalogTranscriptItem {
  const { raw: _raw, ...importable } = item;
  return importable;
}

async function readBoundedSessionCatalogHistory(params: {
  read: (params: { cursor?: string; limit: number }) => Promise<SessionsCatalogReadResult>;
}): Promise<SessionCatalogTranscriptItem[]> {
  const pages: SessionCatalogTranscriptItem[][] = [];
  let cursor: string | undefined;
  let itemCount = 0;
  let bytes = 0;
  let emptyPageCount = 0;
  while (itemCount < SESSION_CATALOG_HISTORY_IMPORT_MAX_ITEMS) {
    const page = await params.read({
      limit: Math.min(
        SESSION_CATALOG_HISTORY_IMPORT_PAGE_LIMIT,
        SESSION_CATALOG_HISTORY_IMPORT_MAX_ITEMS - itemCount,
      ),
      ...(cursor ? { cursor } : {}),
    });
    const retained: SessionCatalogTranscriptItem[] = [];
    // Catalog pages move newest-to-oldest while each page stays chronological.
    // Walk backward for recent-window bounds, then prepend older retained pages.
    for (let index = page.items.length - 1; index >= 0; index -= 1) {
      const item = page.items[index];
      if (!item) {
        continue;
      }
      const importableItem = importableSessionCatalogItem(item);
      const itemBytes = Buffer.byteLength(JSON.stringify(importableItem), "utf8");
      const remainingBytes = SESSION_CATALOG_HISTORY_IMPORT_MAX_BYTES - bytes;
      if (itemCount > 0 && itemBytes > remainingBytes) {
        return [retained, ...pages.toReversed()].flat();
      }
      const retainedItem =
        itemBytes <= remainingBytes
          ? importableItem
          : fitSessionCatalogItemToBytes(importableItem, remainingBytes);
      if (!retainedItem) {
        continue;
      }
      const retainedItemBytes = Buffer.byteLength(JSON.stringify(retainedItem), "utf8");
      retained.unshift(retainedItem);
      itemCount += 1;
      bytes += retainedItemBytes;
      if (
        itemCount === SESSION_CATALOG_HISTORY_IMPORT_MAX_ITEMS ||
        bytes === SESSION_CATALOG_HISTORY_IMPORT_MAX_BYTES
      ) {
        return [retained, ...pages.toReversed()].flat();
      }
    }
    pages.push(retained);
    if (!page.nextCursor || page.nextCursor === cursor) {
      break;
    }
    if (retained.length === 0) {
      emptyPageCount += 1;
      if (emptyPageCount >= SESSION_CATALOG_HISTORY_IMPORT_MAX_EMPTY_PAGES) {
        break;
      }
    } else {
      emptyPageCount = 0;
    }
    cursor = page.nextCursor;
  }
  return pages.toReversed().flat();
}

export async function importSessionCatalogHistory(params: {
  catalogId: string;
  threadId: string;
  read: (params: { cursor?: string; limit: number }) => Promise<SessionsCatalogReadResult>;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  cwd?: string;
  config: OpenClawConfig;
}): Promise<void> {
  const items = await readBoundedSessionCatalogHistory({ read: params.read });
  const fallbackTimestamp = Date.now();
  await withSessionTranscriptWriteLock(params, async (transcript) => {
    for (const [index, item] of items.entries()) {
      const imported = importedSessionCatalogMessage({
        catalogId: params.catalogId,
        item,
        fallbackTimestamp: fallbackTimestamp + index,
      });
      if (!imported) {
        continue;
      }
      const message = {
        ...(imported as unknown as Record<string, unknown>),
        idempotencyKey: `${params.catalogId}-catalog:${params.threadId}:${item.id ?? index}`,
      } as unknown as AgentMessage;
      await transcript.appendMessage({
        message,
        idempotencyLookup: "scan",
        cwd: params.cwd,
      });
    }
  });
}
