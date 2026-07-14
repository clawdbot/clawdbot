type SlackCursorResponse = {
  response_metadata?: { next_cursor?: string };
};

export async function collectSlackCursorPages<
  TItem,
  TResponse extends SlackCursorResponse,
>(params: {
  fetchPage: (cursor?: string) => Promise<TResponse>;
  collectPageItems: (response: TResponse) => TItem[];
}): Promise<TItem[]> {
  const items: TItem[] = [];
  let cursor: string | undefined;
  do {
    const response = await params.fetchPage(cursor);
    items.push(...params.collectPageItems(response));
    cursor = response.response_metadata?.next_cursor?.trim() || undefined;
  } while (cursor);
  return items;
}
