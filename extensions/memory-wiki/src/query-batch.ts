// Memory Wiki helper prepares bounded wiki-only batch search snapshots.
import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import {
  buildDigestCandidatePaths,
  normalizePositiveInteger,
  readQueryDigestBundle,
  readQueryableWikiPages,
  readQueryableWikiPagesByPaths,
  sortWikiSearchResults,
  toWikiSearchResult,
  type QueryableWikiPage,
  type WikiSearchMode,
  type WikiSearchResult,
} from "./query.js";
import { initializeMemoryWikiVault } from "./vault.js";

const BATCH_SNIPPET_MAX_CHARS = 500;

async function existingWikiPaths(vaultPath: string, relativePaths: string[]): Promise<string[]> {
  const paths = await Promise.all(
    relativePaths.map(async (relativePath) => {
      try {
        return (await fs.stat(path.join(vaultPath, relativePath))).isFile() ? relativePath : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    }),
  );
  return paths.filter((value): value is string => value !== null);
}

export type WikiBatchSearchQuery = {
  id: string;
  query: string;
  maxResults?: number;
  mode?: WikiSearchMode;
  expectedPaths?: string[];
  expectedIds?: string[];
};

type WikiBatchSearchResult = {
  id: string;
  query: string;
  candidatePageCount: number;
  results: WikiSearchResult[];
};

export function boundedWikiBatchHit(result: WikiSearchResult) {
  return {
    path: result.path,
    ...(result.id ? { id: result.id } : {}),
    title: result.title,
    pageType: result.kind,
    score: result.score,
    snippet:
      result.snippet.length > BATCH_SNIPPET_MAX_CHARS
        ? `${result.snippet.slice(0, BATCH_SNIPPET_MAX_CHARS - 3)}...`
        : result.snippet,
  };
}

/**
 * Search several wiki-only queries from one prepared digest/page snapshot.
 * Call regular search when imported-source sync or shared-memory lookup is required.
 */
export async function searchMemoryWikiBatch(params: {
  config: ResolvedMemoryWikiConfig;
  queries: WikiBatchSearchQuery[];
}): Promise<WikiBatchSearchResult[]> {
  await initializeMemoryWikiVault(params.config);
  const digest = await readQueryDigestBundle(params.config);
  const candidatePaths = new Map<string, string[]>();
  const allCandidatePaths = new Set<string>();
  for (const item of params.queries) {
    const maxResults = normalizePositiveInteger(item.maxResults, 10);
    const mode = item.mode ?? "auto";
    const expectedIds = new Set((item.expectedIds ?? []).map((value) => value.toLowerCase()));
    const paths = digest
      ? [
          ...new Set([
            ...buildDigestCandidatePaths({
              digest,
              query: item.query,
              maxResults,
              mode,
            }),
            ...(item.expectedPaths ?? []),
            ...digest.pages
              .filter((page) => page.id && expectedIds.has(page.id.toLowerCase()))
              .map((page) => page.path),
          ]),
        ]
      : [];
    candidatePaths.set(item.id, paths);
    for (const pagePath of paths) {
      allCandidatePaths.add(pagePath);
    }
  }

  const preparedCandidates =
    allCandidatePaths.size > 0
      ? await readQueryableWikiPagesByPaths(
          params.config.vault.path,
          await existingWikiPaths(params.config.vault.path, [...allCandidatePaths]),
        )
      : [];
  const preparedByPath = new Map(
    preparedCandidates.map((page) => [page.relativePath, page] as const),
  );
  let allPagesPromise: Promise<QueryableWikiPage[]> | undefined;
  const getAllPages = () => (allPagesPromise ??= readQueryableWikiPages(params.config.vault.path));

  return await Promise.all(
    params.queries.map(async (item) => {
      const maxResults = normalizePositiveInteger(item.maxResults, 10);
      const mode = item.mode ?? "auto";
      const paths = candidatePaths.get(item.id) ?? [];
      const candidatePages = paths
        .map((pagePath) => preparedByPath.get(pagePath))
        .filter((page): page is QueryableWikiPage => Boolean(page));
      const pages = digest ? candidatePages : await getAllPages();
      const results = sortWikiSearchResults(
        pages
          .map((page) => toWikiSearchResult(page, item.query, mode))
          .filter((page) => page.score > 0),
      );
      return {
        id: item.id,
        query: item.query,
        candidatePageCount: pages.length,
        results: results.slice(0, maxResults),
      };
    }),
  );
}
