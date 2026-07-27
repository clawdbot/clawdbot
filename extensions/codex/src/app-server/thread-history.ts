import type {
  CodexThread,
  CodexThreadTurnsListParams,
  CodexThreadTurnsListResponse,
  CodexTurn,
} from "./protocol.js";

const TURN_PAGE_LIMIT = 100;
const PAGINATED_INCLUDE_TURNS_ERROR =
  "paginated threads do not support thread/read(includeTurns=true)";

export type CodexThreadHistoryReader = {
  readThread(threadId: string, includeTurns?: boolean): Promise<CodexThread>;
  listTurnPage(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResponse>;
};

/** Read full turn items in stable oldest-first order, guarding malformed pagination. */
export async function listCodexThreadTurns(
  reader: Pick<CodexThreadHistoryReader, "listTurnPage">,
  threadId: string,
): Promise<CodexTurn[]> {
  const turns: CodexTurn[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await reader.listTurnPage({
      threadId,
      limit: TURN_PAGE_LIMIT,
      sortDirection: "asc",
      itemsView: "full",
      ...(cursor ? { cursor } : {}),
    });
    turns.push(...page.data);
    const nextCursor = page.nextCursor?.trim() || undefined;
    if (!nextCursor) {
      return turns;
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error("Codex returned a repeated thread/turns/list cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

/** Read complete legacy or paginated history without using the unsupported
 * thread/read(includeTurns=true) form for paginated threads. */
export async function readCodexThreadWithTurns(
  reader: CodexThreadHistoryReader,
  threadId: string,
): Promise<CodexThread> {
  try {
    return await reader.readThread(threadId, true);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== PAGINATED_INCLUDE_TURNS_ERROR) {
      throw error;
    }
  }

  const metadata = await reader.readThread(threadId, false);
  if (metadata.id !== threadId) {
    throw new Error("Codex app-server returned a different thread than requested");
  }
  if (metadata.historyMode !== "paginated") {
    throw new Error("Codex rejected a full history read for a non-paginated thread");
  }
  return {
    ...metadata,
    turns: await listCodexThreadTurns(reader, threadId),
  };
}
