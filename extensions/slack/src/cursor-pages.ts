type SlackCursorResponse = {
  response_metadata?: { next_cursor?: string };
};

// Slack documents an empty cursor as the only normal termination signal. This
// backstop is deliberately far above any plausible channel or user directory.
const SLACK_CURSOR_PAGE_LIMIT = 10_000;

export async function collectSlackCursorPages<
  TItem,
  TResponse extends SlackCursorResponse,
>(params: {
  fetchPage: (cursor?: string) => Promise<TResponse>;
  collectPageItems: (response: TResponse) => TItem[];
}): Promise<TItem[]> {
  const items: TItem[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  for (let pageCount = 1; pageCount <= SLACK_CURSOR_PAGE_LIMIT; pageCount += 1) {
    const response = await params.fetchPage(cursor);
    items.push(...params.collectPageItems(response));
    const nextCursor = response.response_metadata?.next_cursor?.trim() || undefined;
    if (!nextCursor) {
      return items;
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error(`Slack cursor pagination repeated a cursor after ${pageCount} pages`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error(`Slack cursor pagination exceeded ${SLACK_CURSOR_PAGE_LIMIT} pages`);
}
