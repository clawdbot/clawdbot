type SlackCursorResponse = {
  response_metadata?: { next_cursor?: string };
};

function readSlackNextCursor(response: SlackCursorResponse): string | undefined {
  const next = response.response_metadata?.next_cursor?.trim();
  return next ? next : undefined;
}

export async function collectSlackCursorItems<
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
    cursor = readSlackNextCursor(response);
  } while (cursor);
  return items;
}

export function resolveSlackAllowlistEntries<
  TParsed extends { id?: string },
  TLookup,
  TResult,
>(params: {
  entries: string[];
  lookup: TLookup[];
  parseInput: (input: string) => TParsed;
  findById: (lookup: TLookup[], id: string) => TLookup | undefined;
  buildIdResolved: (params: { input: string; parsed: TParsed; match?: TLookup }) => TResult;
  resolveNonId: (params: {
    input: string;
    parsed: TParsed;
    lookup: TLookup[];
  }) => TResult | undefined;
  buildUnresolved: (input: string) => TResult;
}): TResult[] {
  const results: TResult[] = [];

  for (const input of params.entries) {
    const parsed = params.parseInput(input);
    if (parsed.id) {
      const match = params.findById(params.lookup, parsed.id);
      results.push(params.buildIdResolved({ input, parsed, match }));
      continue;
    }

    const resolved = params.resolveNonId({
      input,
      parsed,
      lookup: params.lookup,
    });
    if (resolved) {
      results.push(resolved);
      continue;
    }

    results.push(params.buildUnresolved(input));
  }

  return results;
}
