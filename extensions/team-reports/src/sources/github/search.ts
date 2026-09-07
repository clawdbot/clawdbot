import { z } from "zod";
import type { ActivityWindow } from "../../types.js";
import { GithubClient, GithubSourceError, parse, pathWithQuery } from "./client.js";

type SearchQuery =
  | {
      kind: "issues";
      qualifier: "created" | "closed" | "merged" | "updated";
      type: "issue" | "pull-request";
    }
  | { kind: "commits"; qualifier: "committer-date" };

export function searchPath(query: SearchQuery, org: string, start: number, end: number): string {
  const type = query.kind === "issues" ? ` is:${query.type}` : "";
  return pathWithQuery(`/search/${query.kind}`, {
    q: `org:${org}${type} ${query.qualifier}:${new Date(start * 1000).toISOString()}..${new Date(end * 1000).toISOString()}`,
  });
}

export function searchSeconds(window: ActivityWindow): [number, number] {
  return [Math.floor(window.sinceMs / 1000), Math.floor((window.untilMs - 1) / 1000)];
}

export async function* search<T>(
  client: GithubClient,
  query: SearchQuery,
  org: string,
  window: ActivityWindow,
  itemSchema: z.ZodType<T>,
  first?: Awaited<ReturnType<GithubClient["get"]>>,
): AsyncGenerator<T> {
  const { kind } = query;
  const schema = z.object({
    total_count: z.number().int().nonnegative(),
    incomplete_results: z.boolean().optional(),
    items: z.array(itemSchema),
  });
  async function* range(
    start: number,
    end: number,
    initial?: Awaited<ReturnType<GithubClient["get"]>>,
  ): AsyncGenerator<T> {
    let page = initial ?? (await client.get(searchPath(query, org, start, end)));
    let result = parse(schema, page.data);
    if (result.total_count >= 1000 && start < end) {
      client.status.stats.searchSplits = Number(client.status.stats.searchSplits) + 1;
      // Search ranges are inclusive at second precision; disjoint children avoid cap-boundary duplicates.
      const mid = Math.floor((start + end) / 2);
      yield* range(start, mid);
      yield* range(mid + 1, end);
      return;
    }
    if (result.total_count >= 1000) {
      client.warn(
        `${org} ${kind}`,
        new GithubSourceError("Search cap reached within one second; some activity may be missing"),
      );
    }
    const seen = new Set<string>();
    let emitted = 0;
    for (;;) {
      if (result.incomplete_results) {
        client.warn(
          `${org} ${kind}`,
          new GithubSourceError("GitHub returned incomplete search results"),
        );
      }
      yield* result.items;
      emitted += result.items.length;
      if (!page.next || emitted >= 1000) {
        break;
      }
      if (seen.has(page.next)) {
        throw new GithubSourceError("Search pagination did not advance");
      }
      seen.add(page.next);
      page = await client.get(page.next);
      result = parse(schema, page.data);
    }
  }
  yield* range(...searchSeconds(window), first);
}
