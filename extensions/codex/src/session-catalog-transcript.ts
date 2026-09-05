import {
  sessionCatalogPaging,
  type SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import { z } from "zod";
import type { CodexThreadItem, CodexThreadTurnsListResponse } from "./app-server/protocol.js";
import {
  CatalogParamsError,
  MAX_TRANSCRIPT_PAGE_BYTES,
  parseTranscriptPage,
  readControlCursor,
} from "./session-catalog-parsing.js";
import { toGenericTranscriptItem } from "./session-catalog-transcript-item.js";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";

type TranscriptRequest = { threadId: string; cursor?: string; limit: number };
type TranscriptPage = { items: SessionCatalogTranscriptItem[]; nextCursor?: string };
type ReadTurns = (
  params: TranscriptRequest & { sortDirection: "desc"; itemsView: "full" },
) => Promise<CodexThreadTurnsListResponse>;
const TURN_ITEM_CURSOR_PREFIX = "turn-item:";
const transcriptPageSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      id: z.string(),
      type: z.enum(["userMessage", "agentMessage", "reasoning", "toolCall", "toolResult", "other"]),
      text: z.string().optional(),
      raw: z.record(z.string(), z.json()).optional(),
      truncated: z.boolean().optional(),
    }),
  ),
  nextCursor: z.string().optional(),
});

export function parseCodexCatalogTranscriptPage(value: unknown): TranscriptPage {
  return transcriptPageSchema.parse(value);
}

function encodeTurnItemCursor(turnCursor: string, itemId: string): string {
  return (
    TURN_ITEM_CURSOR_PREFIX +
    Buffer.from(JSON.stringify([turnCursor, itemId])).toString("base64url")
  );
}

function decodeTurnItemCursor(cursor?: string): { turnCursor?: string; itemId?: string } {
  if (!cursor?.startsWith(TURN_ITEM_CURSOR_PREFIX)) {
    return { turnCursor: cursor };
  }
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.from(cursor.slice(TURN_ITEM_CURSOR_PREFIX.length), "base64url").toString(),
    );
  } catch {
    throw new CatalogParamsError("invalid Codex transcript item cursor");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    !value[0] ||
    typeof value[1] !== "string" ||
    !value[1]
  ) {
    throw new CatalogParamsError("invalid Codex transcript item cursor");
  }
  return { turnCursor: value[0], itemId: value[1] };
}

function projectTranscriptPage(
  items: CodexThreadItem[],
  limit: number,
): SessionCatalogTranscriptItem[] {
  const projected = items.map(toGenericTranscriptItem);
  const page = sessionCatalogPaging.boundTranscriptPage(projected.toReversed(), limit, 0).items;
  for (const [index, item] of page.entries()) {
    if (item.text !== projected[index]?.text && projected[index]?.text) {
      item.truncated = true;
    }
  }
  return page;
}

function pageFitsNodeTransport(page: TranscriptPage): boolean {
  // node.invoke carries JSON inside payloadJSON. Bound that representation before sending,
  // while retaining the full native raw item for non-UI consumers.
  return (
    Buffer.byteLength(JSON.stringify({ payloadJSON: JSON.stringify(page) }), "utf8") <=
    MAX_TRANSCRIPT_PAGE_BYTES
  );
}

/** The legacy API can anchor a turn, but cannot continue within that turn. */
export async function readLegacyCodexTranscriptPage(
  readTurns: ReadTurns,
  request: TranscriptRequest,
): Promise<TranscriptPage> {
  const { turnCursor, itemId } = decodeTurnItemCursor(request.cursor);
  const page = parseTranscriptPage(
    await readTurns({
      threadId: request.threadId,
      limit: 1,
      sortDirection: "desc",
      itemsView: "full",
      ...(turnCursor ? { cursor: turnCursor } : {}),
    }),
  );
  const source = page.data.flatMap((turn) => turn.items.toReversed());
  // Appends can shift a turn's newest-relative offsets. The delivered item is the
  // stable boundary, so later pages neither replay it nor skip older items.
  const anchorIndex = itemId ? source.findIndex((item) => item.id === itemId) : -1;
  if (itemId && anchorIndex < 0) {
    throw new CatalogParamsError(
      "Codex transcript changed; refresh the session before loading older items",
    );
  }
  const remaining = source.slice(anchorIndex + 1);
  const items = projectTranscriptPage(remaining, request.limit);
  const result = (): TranscriptPage => {
    const lastSource = remaining[items.length - 1];
    const partial = lastSource !== undefined && items.length < remaining.length;
    const nativeCursor = partial ? page.backwardsCursor : page.nextCursor;
    const cursor = nativeCursor
      ? partial
        ? encodeTurnItemCursor(nativeCursor, lastSource.id)
        : nativeCursor
      : undefined;
    if (partial && !cursor) {
      throw new Error("Codex app-server did not provide a transcript continuation anchor");
    }
    return { items, ...(cursor ? { nextCursor: cursor } : {}) };
  };
  let bounded = result();
  while (!pageFitsNodeTransport(bounded)) {
    if (items.length <= 1) {
      throw new Error("Codex transcript item exceeds the safe response size");
    }
    items.pop();
    bounded = result();
  }
  return bounded;
}

/** Uses the native store's item cursor whenever that store supports item history. */
export async function readCodexCatalogTranscriptPage(
  control: CodexSessionCatalogControl,
  request: TranscriptRequest,
): Promise<TranscriptPage> {
  const thread = await control.requireEligibleThread(request.threadId);
  if (thread.historyMode !== "paginated") {
    return readLegacyCodexTranscriptPage((params) => control.listTurnPage(params), request);
  }
  let limit = request.limit;
  for (;;) {
    const page = await control.listItemPage({
      threadId: request.threadId,
      limit,
      sortDirection: "desc",
      ...(request.cursor ? { cursor: request.cursor } : {}),
    });
    const nextCursor = readControlCursor(page.nextCursor, "transcript next response");
    const items = projectTranscriptPage(
      page.data.map(({ item }) => item),
      limit,
    );
    const result = { items, ...(nextCursor ? { nextCursor } : {}) };
    const fittingCount = items.length - (pageFitsNodeTransport(result) ? 0 : 1);
    if (fittingCount === page.data.length) {
      return result;
    }
    if (fittingCount < 1) {
      throw new Error("Codex transcript item exceeds the safe response size");
    }
    // Re-read the same anchor with a strictly smaller count. The returned native cursor
    // must describe exactly the items sent; slicing while retaining it would skip history.
    limit = fittingCount;
  }
}
