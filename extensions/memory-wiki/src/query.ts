import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentId, resolveSessionAgentId } from "openclaw/plugin-sdk/memory-host-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-host-files";
import { getActiveMemorySearchManager } from "openclaw/plugin-sdk/memory-host-search";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { OpenClawConfig } from "../api.js";
import { assessClaimFreshness, isClaimContestedStatus } from "./claim-health.js";
import type { ResolvedMemoryWikiConfig, WikiSearchBackend, WikiSearchCorpus } from "./config.js";
import {
  parseWikiMarkdown,
  toWikiPageSummary,
  type WikiClaim,
  type WikiPageSummary,
} from "./markdown.js";
import { initializeMemoryWikiVault } from "./vault.js";

const QUERY_DIRS = ["entities", "concepts", "sources", "syntheses", "reports"] as const;
const AGENT_DIGEST_PATH = ".openclaw-wiki/cache/agent-digest.json";
const CLAIMS_DIGEST_PATH = ".openclaw-wiki/cache/claims.jsonl";

type QueryDigestPage = {
  id?: string;
  title: string;
  kind: WikiPageSummary["kind"];
  path: string;
  sourceIds: string[];
  questions: string[];
  contradictions: string[];
};

type QueryDigestClaim = {
  id?: string;
  pageId?: string;
  pageTitle: string;
  pageKind: WikiPageSummary["kind"];
  pagePath: string;
  text: string;
  status?: string;
  confidence?: number;
  sourceIds?: string[];
  freshnessLevel?: string;
  lastTouchedAt?: string;
};

type QueryDigestBundle = {
  pages: QueryDigestPage[];
  claims: QueryDigestClaim[];
};

export type WikiSearchResult = {
  corpus: "wiki" | "memory";
  path: string;
  title: string;
  kind: WikiPageSummary["kind"] | "memory";
  score: number;
  snippet: string;
  id?: string;
  startLine?: number;
  endLine?: number;
  citation?: string;
  memorySource?: MemorySearchResult["source"];
  sourceType?: string;
  provenanceMode?: string;
  sourcePath?: string;
  provenanceLabel?: string;
  updatedAt?: string;
};

export type WikiGetResult = {
  corpus: "wiki" | "memory";
  path: string;
  title: string;
  kind: WikiPageSummary["kind"] | "memory";
  content: string;
  fromLine: number;
  lineCount: number;
  totalLines?: number;
  truncated?: boolean;
  id?: string;
  sourceType?: string;
  provenanceMode?: string;
  sourcePath?: string;
  provenanceLabel?: string;
  updatedAt?: string;
};

export type QueryableWikiPage = WikiPageSummary & {
  raw: string;
};

type QuerySearchOverrides = {
  searchBackend?: WikiSearchBackend;
  searchCorpus?: WikiSearchCorpus;
};

async function listWikiMarkdownFiles(rootDir: string): Promise<string[]> {
  const files = (
    await Promise.all(
      QUERY_DIRS.map(async (relativeDir) => {
        const dirPath = path.join(rootDir, relativeDir);
        const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
        return entries
          .filter(
            (entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md",
          )
          .map((entry) => path.join(relativeDir, entry.name));
      }),
    )
  ).flat();
  return files.toSorted((left, right) => left.localeCompare(right));
}

export async function readQueryableWikiPages(rootDir: string): Promise<QueryableWikiPage[]> {
  const files = await listWikiMarkdownFiles(rootDir);
  return readQueryableWikiPagesByPaths(rootDir, files);
}

async function readQueryableWikiPagesByPaths(
  rootDir: string,
  files: string[],
): Promise<QueryableWikiPage[]> {
  const pages = await Promise.all(
    files.map(async (relativePath) => {
      const absolutePath = path.join(rootDir, relativePath);
      const raw = await fs.readFile(absolutePath, "utf8");
      const summary = toWikiPageSummary({ absolutePath, relativePath, raw });
      return summary ? { ...summary, raw } : null;
    }),
  );
  return pages.flatMap((page) => (page ? [page] : []));
}

function parseClaimsDigest(raw: string): QueryDigestClaim[] {
  return raw.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return [];
    }
    try {
      const parsed = JSON.parse(trimmed) as QueryDigestClaim;
      if (!parsed || typeof parsed !== "object" || typeof parsed.pagePath !== "string") {
        return [];
      }
      return [parsed];
    } catch {
      return [];
    }
  });
}

async function readQueryDigestBundle(rootDir: string): Promise<QueryDigestBundle | null> {
  const [agentDigestRaw, claimsDigestRaw] = await Promise.all([
    fs.readFile(path.join(rootDir, AGENT_DIGEST_PATH), "utf8").catch(() => null),
    fs.readFile(path.join(rootDir, CLAIMS_DIGEST_PATH), "utf8").catch(() => null),
  ]);
  if (!agentDigestRaw && !claimsDigestRaw) {
    return null;
  }

  const pages = (() => {
    if (!agentDigestRaw) {
      return [];
    }
    try {
      const parsed = JSON.parse(agentDigestRaw) as { pages?: QueryDigestPage[] };
      return Array.isArray(parsed.pages) ? parsed.pages : [];
    } catch {
      return [];
    }
  })();
  const claims = claimsDigestRaw ? parseClaimsDigest(claimsDigestRaw) : [];

  if (pages.length === 0 && claims.length === 0) {
    return null;
  }

  return { pages, claims };
}

function buildSnippet(raw: string, query: string): string {
  const queryLower = normalizeLowercaseStringOrEmpty(query);
  const matchingLine = raw
    .split(/\r?\n/)
    .find(
      (line) =>
        normalizeLowercaseStringOrEmpty(line).includes(queryLower) && line.trim().length > 0,
    );
  return (
    matchingLine?.trim() ||
    raw
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ||
    ""
  );
}

function buildPageSearchText(page: QueryableWikiPage): string {
  return [
    page.title,
    page.relativePath,
    page.id ?? "",
    page.sourceIds.join(" "),
    page.questions.join(" "),
    page.contradictions.join(" "),
    page.claims.map((claim) => claim.text).join(" "),
    page.claims.map((claim) => claim.id ?? "").join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}

function buildDigestPageSearchText(page: QueryDigestPage, claims: QueryDigestClaim[]): string {
  return [
    page.title,
    page.path,
    page.id ?? "",
    page.sourceIds.join(" "),
    page.questions.join(" "),
    page.contradictions.join(" "),
    claims.map((claim) => claim.text).join(" "),
    claims.map((claim) => claim.id ?? "").join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}

function isClaimTextOrIdMatch(
  claim: Pick<QueryDigestClaim, "id" | "text"> | Pick<WikiClaim, "id" | "text">,
  queryLower: string,
): boolean {
  if (normalizeLowercaseStringOrEmpty(claim.text).includes(queryLower)) {
    return true;
  }
  return normalizeLowercaseStringOrEmpty(claim.id).includes(queryLower);
}

function scoreClaimMatch(params: {
  text: string;
  id?: string;
  confidence?: number;
  status?: string;
  freshnessLevel?: string;
  queryLower: string;
}): number {
  let score = 0;
  if (normalizeLowercaseStringOrEmpty(params.text).includes(params.queryLower)) {
    score += 25;
  }
  if (normalizeLowercaseStringOrEmpty(params.id).includes(params.queryLower)) {
    score += 10;
  }
  if (typeof params.confidence === "number") {
    score += Math.round(params.confidence * 10);
  }
  switch (params.freshnessLevel) {
    case "fresh":
      score += 8;
      break;
    case "aging":
      score += 4;
      break;
    case "stale":
      score -= 2;
      break;
    case "unknown":
      score -= 4;
      break;
  }
  score += isClaimContestedStatus(params.status) ? -6 : 4;
  return score;
}

function scoreDigestClaimMatch(claim: QueryDigestClaim, queryLower: string): number {
  return scoreClaimMatch({
    text: claim.text,
    id: claim.id,
    confidence: claim.confidence,
    status: claim.status,
    freshnessLevel: claim.freshnessLevel,
    queryLower,
  });
}

function scoreWikiMetadataMatch(params: {
  title: string;
  path: string;
  id?: string;
  sourceIds: readonly string[];
  queryLower: string;
}): number {
  let score = 0;
  const titleLower = normalizeLowercaseStringOrEmpty(params.title);
  const pathLower = normalizeLowercaseStringOrEmpty(params.path);
  const idLower = normalizeLowercaseStringOrEmpty(params.id);
  if (titleLower === params.queryLower) {
    score += 50;
  } else if (titleLower.includes(params.queryLower)) {
    score += 20;
  }
  if (pathLower.includes(params.queryLower)) {
    score += 10;
  }
  if (idLower.includes(params.queryLower)) {
    score += 20;
  }
  if (
    params.sourceIds.some((sourceId) =>
      normalizeLowercaseStringOrEmpty(sourceId).includes(params.queryLower),
    )
  ) {
    score += 12;
  }
  return score;
}

function buildDigestCandidatePaths(params: {
  digest: QueryDigestBundle;
  query: string;
  maxResults: number;
}): string[] {
  const queryLower = normalizeLowercaseStringOrEmpty(params.query);
  const claimsByPage = new Map<string, QueryDigestClaim[]>();
  for (const claim of params.digest.claims) {
    const current = claimsByPage.get(claim.pagePath) ?? [];
    current.push(claim);
    claimsByPage.set(claim.pagePath, current);
  }

  return params.digest.pages
    .map((page) => {
      const claims = claimsByPage.get(page.path) ?? [];
      const metadataLower = normalizeLowercaseStringOrEmpty(
        buildDigestPageSearchText(page, claims),
      );
      if (!metadataLower.includes(queryLower)) {
        return { path: page.path, score: 0 };
      }
      let score =
        1 +
        scoreWikiMetadataMatch({
          title: page.title,
          path: page.path,
          id: page.id,
          sourceIds: page.sourceIds,
          queryLower,
        });
      const matchingClaims = claims
        .filter((claim) => isClaimTextOrIdMatch(claim, queryLower))
        .toSorted(
          (left, right) =>
            scoreDigestClaimMatch(right, queryLower) - scoreDigestClaimMatch(left, queryLower),
        );
      if (matchingClaims.length > 0) {
        score += scoreDigestClaimMatch(matchingClaims[0], queryLower);
        score += Math.min(10, (matchingClaims.length - 1) * 2);
      }
      return { path: page.path, score };
    })
    .filter((candidate) => candidate.score > 0)
    .toSorted((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, Math.max(params.maxResults * 4, 20))
    .map((candidate) => candidate.path);
}

function isClaimMatch(claim: WikiClaim, queryLower: string): boolean {
  return isClaimTextOrIdMatch(claim, queryLower);
}

function rankClaimMatch(page: QueryableWikiPage, claim: WikiClaim, queryLower: string): number {
  const freshness = assessClaimFreshness({ page, claim });
  return scoreClaimMatch({
    text: claim.text,
    id: claim.id,
    confidence: claim.confidence,
    status: claim.status,
    freshnessLevel: freshness.level,
    queryLower,
  });
}

function getMatchingClaims(page: QueryableWikiPage, queryLower: string): WikiClaim[] {
  return page.claims
    .filter((claim) => isClaimMatch(claim, queryLower))
    .toSorted(
      (left, right) =>
        rankClaimMatch(page, right, queryLower) - rankClaimMatch(page, left, queryLower),
    );
}

function buildPageSnippet(page: QueryableWikiPage, query: string): string {
  const queryLower = normalizeLowercaseStringOrEmpty(query);
  const matchingClaim = getMatchingClaims(page, queryLower)[0];
  if (matchingClaim) {
    return matchingClaim.text;
  }
  return buildSnippet(page.raw, query);
}

function scorePage(page: QueryableWikiPage, query: string): number {
  const queryLower = normalizeLowercaseStringOrEmpty(query);
  const titleLower = normalizeLowercaseStringOrEmpty(page.title);
  const pathLower = normalizeLowercaseStringOrEmpty(page.relativePath);
  const idLower = normalizeLowercaseStringOrEmpty(page.id);
  const metadataLower = normalizeLowercaseStringOrEmpty(buildPageSearchText(page));
  const rawLower = normalizeLowercaseStringOrEmpty(page.raw);
  if (
    !(
      titleLower.includes(queryLower) ||
      pathLower.includes(queryLower) ||
      idLower.includes(queryLower) ||
      metadataLower.includes(queryLower) ||
      rawLower.includes(queryLower)
    )
  ) {
    return 0;
  }

  let score =
    1 +
    scoreWikiMetadataMatch({
      title: page.title,
      path: page.relativePath,
      id: page.id,
      sourceIds: page.sourceIds,
      queryLower,
    });
  const matchingClaims = getMatchingClaims(page, queryLower);
  if (matchingClaims.length > 0) {
    score += rankClaimMatch(page, matchingClaims[0], queryLower);
    score += Math.min(10, (matchingClaims.length - 1) * 2);
  }
  const bodyOccurrences = rawLower.split(queryLower).length - 1;
  score += Math.min(10, bodyOccurrences);
  return score;
}

function normalizeLookupKey(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  return normalized.endsWith(".md") ? normalized : normalized.replace(/\/+$/, "");
}

function buildLookupCandidates(lookup: string): string[] {
  const normalized = normalizeLookupKey(lookup);
  const withExtension = normalized.endsWith(".md") ? normalized : `${normalized}.md`;
  return [...new Set([normalized, withExtension])];
}

function shouldSearchWiki(config: ResolvedMemoryWikiConfig): boolean {
  return config.search.corpus === "wiki" || config.search.corpus === "all";
}

function shouldSearchSharedMemory(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): boolean {
  return (
    config.search.backend === "shared" &&
    appConfig !== undefined &&
    (config.search.corpus === "memory" || config.search.corpus === "all")
  );
}

function resolveActiveMemoryAgentId(params: {
  appConfig?: OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
}): string | null {
  if (!params.appConfig) {
    return null;
  }
  if (params.agentId?.trim()) {
    return params.agentId.trim();
  }
  if (params.agentSessionKey?.trim()) {
    return resolveSessionAgentId({
      sessionKey: params.agentSessionKey,
      config: params.appConfig,
    });
  }
  return resolveDefaultAgentId(params.appConfig);
}

async function resolveActiveMemoryManager(params: {
  appConfig?: OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
}) {
  const agentId = resolveActiveMemoryAgentId(params);
  if (!params.appConfig || !agentId) {
    return null;
  }
  try {
    const { manager } = await getActiveMemorySearchManager({
      cfg: params.appConfig,
      agentId,
    });
    return manager;
  } catch {
    return null;
  }
}

function buildMemorySearchTitle(resultPath: string): string {
  const basename = path.basename(resultPath, path.extname(resultPath));
  return basename.length > 0 ? basename : resultPath;
}

function applySearchOverrides(
  config: ResolvedMemoryWikiConfig,
  overrides?: QuerySearchOverrides,
): ResolvedMemoryWikiConfig {
  if (!overrides?.searchBackend && !overrides?.searchCorpus) {
    return config;
  }
  return {
    ...config,
    search: {
      backend: overrides.searchBackend ?? config.search.backend,
      corpus: overrides.searchCorpus ?? config.search.corpus,
    },
  };
}

function buildWikiProvenanceLabel(
  page: Pick<
    WikiPageSummary,
    | "sourceType"
    | "provenanceMode"
    | "bridgeRelativePath"
    | "unsafeLocalRelativePath"
    | "relativePath"
  >,
): string | undefined {
  if (page.sourceType === "memory-bridge-events") {
    return `bridge events: ${page.bridgeRelativePath ?? page.relativePath}`;
  }
  if (page.sourceType === "memory-bridge") {
    return `bridge: ${page.bridgeRelativePath ?? page.relativePath}`;
  }
  if (page.provenanceMode === "unsafe-local" || page.sourceType === "memory-unsafe-local") {
    return `unsafe-local: ${page.unsafeLocalRelativePath ?? page.relativePath}`;
  }
  return undefined;
}

function buildWikiResultMetadata(
  page: Pick<
    WikiPageSummary,
    | "id"
    | "sourceType"
    | "provenanceMode"
    | "sourcePath"
    | "updatedAt"
    | "bridgeRelativePath"
    | "unsafeLocalRelativePath"
    | "relativePath"
  >,
): Partial<
  Pick<
    WikiSearchResult,
    "id" | "sourceType" | "provenanceMode" | "sourcePath" | "provenanceLabel" | "updatedAt"
  >
> {
  const provenanceLabel = buildWikiProvenanceLabel(page);
  return {
    ...(page.id ? { id: page.id } : {}),
    ...(page.sourceType ? { sourceType: page.sourceType } : {}),
    ...(page.provenanceMode ? { provenanceMode: page.provenanceMode } : {}),
    ...(page.sourcePath ? { sourcePath: page.sourcePath } : {}),
    ...(provenanceLabel ? { provenanceLabel } : {}),
    ...(page.updatedAt ? { updatedAt: page.updatedAt } : {}),
  };
}

function toWikiSearchResult(page: QueryableWikiPage, query: string): WikiSearchResult {
  return {
    corpus: "wiki",
    path: page.relativePath,
    title: page.title,
    kind: page.kind,
    score: scorePage(page, query),
    snippet: buildPageSnippet(page, query),
    ...buildWikiResultMetadata(page),
  };
}

function toMemoryWikiSearchResult(result: MemorySearchResult): WikiSearchResult {
  return {
    corpus: "memory",
    path: result.path,
    title: buildMemorySearchTitle(result.path),
    kind: "memory",
    score: result.score,
    snippet: result.snippet,
    startLine: result.startLine,
    endLine: result.endLine,
    memorySource: result.source,
    ...(result.citation ? { citation: result.citation } : {}),
  };
}

async function searchWikiCorpus(params: {
  rootDir: string;
  query: string;
  maxResults: number;
}): Promise<WikiSearchResult[]> {
  const digest = await readQueryDigestBundle(params.rootDir);
  const candidatePaths = digest
    ? buildDigestCandidatePaths({
        digest,
        query: params.query,
        maxResults: params.maxResults,
      })
    : [];
  const seenPaths = new Set<string>();
  const candidatePages =
    candidatePaths.length > 0
      ? await readQueryableWikiPagesByPaths(params.rootDir, candidatePaths)
      : await readQueryableWikiPages(params.rootDir);
  for (const page of candidatePages) {
    seenPaths.add(page.relativePath);
  }

  const results = candidatePages
    .map((page) => toWikiSearchResult(page, params.query))
    .filter((page) => page.score > 0);
  if (candidatePaths.length === 0 || results.length >= params.maxResults) {
    return results;
  }

  const remainingPaths = (await listWikiMarkdownFiles(params.rootDir)).filter(
    (relativePath) => !seenPaths.has(relativePath),
  );
  const remainingPages = await readQueryableWikiPagesByPaths(params.rootDir, remainingPaths);
  return [
    ...results,
    ...remainingPages
      .map((page) => toWikiSearchResult(page, params.query))
      .filter((page) => page.score > 0),
  ];
}

function resolveDigestClaimLookup(digest: QueryDigestBundle, lookup: string): string | null {
  const trimmed = lookup.trim();
  const claimId = trimmed.replace(/^claim:/i, "");
  const match = digest.claims.find((claim) => claim.id === claimId);
  return match?.pagePath ?? null;
}

export function resolveQueryableWikiPageByLookup(
  pages: QueryableWikiPage[],
  lookup: string,
): QueryableWikiPage | null {
  const key = normalizeLookupKey(lookup);
  const withExtension = key.endsWith(".md") ? key : `${key}.md`;
  return (
    pages.find((page) => page.relativePath === key) ??
    pages.find((page) => page.relativePath === withExtension) ??
    pages.find((page) => page.relativePath.replace(/\.md$/i, "") === key) ??
    pages.find((page) => path.basename(page.relativePath, ".md") === key) ??
    pages.find((page) => page.id === key) ??
    null
  );
}

export async function searchMemoryWiki(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
  query: string;
  maxResults?: number;
  searchBackend?: WikiSearchBackend;
  searchCorpus?: WikiSearchCorpus;
}): Promise<WikiSearchResult[]> {
  const effectiveConfig = applySearchOverrides(params.config, params);
  await initializeMemoryWikiVault(effectiveConfig);
  const maxResults = Math.max(1, params.maxResults ?? 10);

  const wikiResults = shouldSearchWiki(effectiveConfig)
    ? await searchWikiCorpus({
        rootDir: effectiveConfig.vault.path,
        query: params.query,
        maxResults,
      })
    : [];

  const sharedMemoryManager = shouldSearchSharedMemory(effectiveConfig, params.appConfig)
    ? await resolveActiveMemoryManager({
        appConfig: params.appConfig,
        agentId: params.agentId,
        agentSessionKey: params.agentSessionKey,
      })
    : null;
  const memoryResults = sharedMemoryManager
    ? (await sharedMemoryManager.search(params.query, { maxResults })).map((result) =>
        toMemoryWikiSearchResult(result),
      )
    : [];

  return [...wikiResults, ...memoryResults]
    .toSorted((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.title.localeCompare(right.title);
    })
    .slice(0, maxResults);
}

export async function getMemoryWikiPage(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
  lookup: string;
  fromLine?: number;
  lineCount?: number;
  searchBackend?: WikiSearchBackend;
  searchCorpus?: WikiSearchCorpus;
}): Promise<WikiGetResult | null> {
  const effectiveConfig = applySearchOverrides(params.config, params);
  await initializeMemoryWikiVault(effectiveConfig);
  const fromLine = Math.max(1, params.fromLine ?? 1);
  const lineCount = Math.max(1, params.lineCount ?? 200);

  if (shouldSearchWiki(effectiveConfig)) {
    const digest = await readQueryDigestBundle(effectiveConfig.vault.path);
    const digestClaimPagePath = digest ? resolveDigestClaimLookup(digest, params.lookup) : null;
    const digestLookupPage = digestClaimPagePath
      ? ((
          await readQueryableWikiPagesByPaths(effectiveConfig.vault.path, [digestClaimPagePath])
        )[0] ?? null)
      : null;
    const pages = digestLookupPage
      ? [digestLookupPage]
      : await readQueryableWikiPages(effectiveConfig.vault.path);
    const page = digestLookupPage ?? resolveQueryableWikiPageByLookup(pages, params.lookup);
    if (page) {
      const parsed = parseWikiMarkdown(page.raw);
      const lines = parsed.body.split(/\r?\n/);
      const totalLines = lines.length;
      const slice = lines.slice(fromLine - 1, fromLine - 1 + lineCount).join("\n");
      const truncated = fromLine - 1 + lineCount < totalLines;

      return {
        corpus: "wiki",
        path: page.relativePath,
        title: page.title,
        kind: page.kind,
        content: slice,
        fromLine,
        lineCount,
        totalLines,
        truncated,
        ...buildWikiResultMetadata(page),
      };
    }
  }

  if (!shouldSearchSharedMemory(effectiveConfig, params.appConfig)) {
    return null;
  }

  const manager = await resolveActiveMemoryManager({
    appConfig: params.appConfig,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
  });
  if (!manager) {
    return null;
  }

  for (const relPath of buildLookupCandidates(params.lookup)) {
    try {
      const result = await manager.readFile({
        relPath,
        from: fromLine,
        lines: lineCount,
      });
      return {
        corpus: "memory",
        path: result.path,
        title: buildMemorySearchTitle(result.path),
        kind: "memory",
        content: result.text,
        fromLine,
        lineCount,
      };
    } catch {
      continue;
    }
  }

  return null;
}
