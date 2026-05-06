import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentId, resolveSessionAgentId } from "openclaw/plugin-sdk/memory-host-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-host-files";
import { getActiveMemorySearchManager } from "openclaw/plugin-sdk/memory-host-search";
import {
  extractTranscriptStemFromSessionsMemoryHit,
  loadCombinedSessionStoreForGateway,
  resolveTranscriptStemToSessionKeys,
} from "openclaw/plugin-sdk/session-transcript-hit";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
} from "openclaw/plugin-sdk/session-visibility";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { OpenClawConfig } from "../api.js";
import { assessClaimFreshness, isClaimContestedStatus } from "./claim-health.js";
import type { ResolvedMemoryWikiConfig, WikiSearchBackend, WikiSearchCorpus } from "./config.js";
import {
  parseWikiMarkdown,
  toWikiPageSummary,
  type WikiClaim,
  type WikiPageSummary,
  type WikiRelationship,
} from "./markdown.js";
import { initializeMemoryWikiVault } from "./vault.js";

const QUERY_DIRS = ["entities", "concepts", "sources", "syntheses", "reports"] as const;
const AGENT_DIGEST_PATH = ".openclaw-wiki/cache/agent-digest.json";
const CLAIMS_DIGEST_PATH = ".openclaw-wiki/cache/claims.jsonl";
const RELATED_BLOCK_PATTERN =
  /<!-- openclaw:wiki:related:start -->[\s\S]*?<!-- openclaw:wiki:related:end -->/g;
const MARKDOWN_FRONTMATTER_PATTERN = /^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const ROUTE_QUESTION_STOP_WORDS = new Set([
  "a",
  "about",
  "am",
  "an",
  "are",
  "ask",
  "asking",
  "be",
  "been",
  "being",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "help",
  "how",
  "i",
  "in",
  "is",
  "know",
  "knows",
  "me",
  "my",
  "need",
  "needs",
  "of",
  "on",
  "or",
  "our",
  "question",
  "questions",
  "should",
  "the",
  "to",
  "us",
  "we",
  "what",
  "when",
  "where",
  "who",
  "whom",
  "whose",
  "why",
  "with",
  "would",
]);

export const WIKI_SEARCH_MODES = [
  "auto",
  "find-person",
  "route-question",
  "source-evidence",
  "raw-claim",
] as const;

export type WikiSearchMode = (typeof WIKI_SEARCH_MODES)[number];

type QueryDigestPage = {
  id?: string;
  title: string;
  kind: WikiPageSummary["kind"];
  path: string;
  pageType?: string;
  entityType?: string;
  canonicalId?: string;
  aliases?: string[];
  sourceIds: string[];
  questions: string[];
  contradictions: string[];
  privacyTier?: string;
  personCard?: WikiPageSummary["personCard"];
  bestUsedFor?: string[];
  notEnoughFor?: string[];
  relationshipCount?: number;
  topRelationships?: WikiRelationship[];
};

type QueryDigestClaim = {
  id?: string;
  pageId?: string;
  pageTitle: string;
  pageKind: WikiPageSummary["kind"];
  pagePath: string;
  pageType?: string;
  entityType?: string;
  canonicalId?: string;
  aliases?: string[];
  text: string;
  status?: string;
  confidence?: number;
  sourceIds?: string[];
  evidenceKinds?: string[];
  privacyTiers?: string[];
  freshnessLevel?: string;
  lastTouchedAt?: string;
};

type QueryDigestBundle = {
  pages: QueryDigestPage[];
  claims: QueryDigestClaim[];
};

type WikiSearchResult = {
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
  searchMode?: WikiSearchMode;
  entityType?: string;
  canonicalId?: string;
  aliases?: string[];
  privacyTier?: string;
  matchedClaimId?: string;
  matchedClaimStatus?: string;
  matchedClaimConfidence?: number;
  evidenceKinds?: string[];
  evidenceSourceIds?: string[];
};

type WikiGetResult = {
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

function sortWikiSearchResults(results: WikiSearchResult[]): WikiSearchResult[] {
  return results.toSorted((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.title.localeCompare(right.title);
  });
}

function mergeWikiSearchCorpusResults(params: {
  wikiResults: WikiSearchResult[];
  memoryResults: WikiSearchResult[];
  maxResults: number;
  balanceCorpora: boolean;
}): WikiSearchResult[] {
  const wikiResults = sortWikiSearchResults(params.wikiResults);
  const memoryResults = sortWikiSearchResults(params.memoryResults);
  if (!params.balanceCorpora || wikiResults.length === 0 || memoryResults.length === 0) {
    return sortWikiSearchResults([...wikiResults, ...memoryResults]).slice(0, params.maxResults);
  }

  const perCorpusCap = Math.ceil(params.maxResults / 2);
  const selectedWiki = wikiResults.slice(0, perCorpusCap);
  const selectedMemory = memoryResults.slice(0, perCorpusCap);
  const selected = [...selectedWiki, ...selectedMemory];
  if (selected.length < params.maxResults) {
    selected.push(
      ...sortWikiSearchResults([
        ...wikiResults.slice(selectedWiki.length),
        ...memoryResults.slice(selectedMemory.length),
      ]).slice(0, params.maxResults - selected.length),
    );
  }

  return sortWikiSearchResults(selected).slice(0, params.maxResults);
}

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
  const queryTokens = buildQueryTokens(queryLower);
  const searchable = buildSnippetSearchText(raw);
  const lines = searchable.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const matchingLine =
    lines.find((line) =>
      lineMatchesQuery(normalizeLowercaseStringOrEmpty(line), queryLower, queryTokens),
    ) ??
    lines
      .map((line) => ({
        line,
        hits: queryTokens.filter((token) => normalizeLowercaseStringOrEmpty(line).includes(token))
          .length,
      }))
      .toSorted((left, right) => right.hits - left.hits)
      .find((candidate) => candidate.hits > 0)?.line;
  return matchingLine?.trim() || lines.find((line) => line.trim() !== "---")?.trim() || "";
}

function buildPageSearchText(page: QueryableWikiPage): string {
  return [
    page.title,
    page.relativePath,
    page.id ?? "",
    page.pageType ?? "",
    page.entityType ?? "",
    page.canonicalId ?? "",
    page.aliases.join(" "),
    page.sourceIds.join(" "),
    page.questions.join(" "),
    page.contradictions.join(" "),
    page.privacyTier ?? "",
    page.bestUsedFor.join(" "),
    page.notEnoughFor.join(" "),
    page.personCard?.canonicalId ?? "",
    page.personCard?.handles.join(" ") ?? "",
    page.personCard?.socials.join(" ") ?? "",
    page.personCard?.emails.join(" ") ?? "",
    page.personCard?.timezone ?? "",
    page.personCard?.lane ?? "",
    page.personCard?.askFor.join(" ") ?? "",
    page.personCard?.avoidAskingFor.join(" ") ?? "",
    page.personCard?.bestUsedFor.join(" ") ?? "",
    page.personCard?.notEnoughFor.join(" ") ?? "",
    page.relationships
      .flatMap((relationship) => [
        relationship.targetId ?? "",
        relationship.targetPath ?? "",
        relationship.targetTitle ?? "",
        relationship.kind ?? "",
        relationship.evidenceKind ?? "",
        relationship.note ?? "",
      ])
      .join(" "),
    page.claims.map((claim) => claim.text).join(" "),
    page.claims.map((claim) => claim.id ?? "").join(" "),
    page.claims
      .flatMap((claim) =>
        claim.evidence.flatMap((evidence) => [
          evidence.kind ?? "",
          evidence.sourceId ?? "",
          evidence.path ?? "",
          evidence.lines ?? "",
          evidence.note ?? "",
          evidence.privacyTier ?? "",
        ]),
      )
      .join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}

function stripGeneratedRelatedBlock(raw: string): string {
  return raw.replace(RELATED_BLOCK_PATTERN, "");
}

function buildSnippetSearchText(raw: string): string {
  return stripGeneratedRelatedBlock(raw).replace(MARKDOWN_FRONTMATTER_PATTERN, "");
}

function buildQueryTokens(queryLower: string): string[] {
  return [
    ...new Set(
      queryLower
        .split(/[^a-z0-9@._-]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  ];
}

function buildRouteQuestionTokens(queryLower: string): string[] {
  const tokens = buildQueryTokens(queryLower);
  const routedTokens = tokens.filter((token) => !ROUTE_QUESTION_STOP_WORDS.has(token));
  return routedTokens.length > 0 ? routedTokens : tokens;
}

function lineMatchesQuery(lineLower: string, queryLower: string, queryTokens: string[]): boolean {
  if (queryLower.length > 0 && lineLower.includes(queryLower)) {
    return true;
  }
  return queryTokens.length > 0 && queryTokens.every((token) => lineLower.includes(token));
}

function buildDigestPageSearchText(page: QueryDigestPage, claims: QueryDigestClaim[]): string {
  return [
    page.title,
    page.path,
    page.id ?? "",
    page.pageType ?? "",
    page.entityType ?? "",
    page.canonicalId ?? "",
    page.aliases?.join(" ") ?? "",
    page.sourceIds.join(" "),
    page.questions.join(" "),
    page.contradictions.join(" "),
    page.privacyTier ?? "",
    page.bestUsedFor?.join(" ") ?? "",
    page.notEnoughFor?.join(" ") ?? "",
    page.personCard?.canonicalId ?? "",
    page.personCard?.handles.join(" ") ?? "",
    page.personCard?.socials.join(" ") ?? "",
    page.personCard?.emails.join(" ") ?? "",
    page.personCard?.timezone ?? "",
    page.personCard?.lane ?? "",
    page.personCard?.askFor.join(" ") ?? "",
    page.personCard?.avoidAskingFor.join(" ") ?? "",
    page.personCard?.bestUsedFor.join(" ") ?? "",
    page.personCard?.notEnoughFor.join(" ") ?? "",
    page.topRelationships
      ?.flatMap((relationship) => [
        relationship.targetId ?? "",
        relationship.targetPath ?? "",
        relationship.targetTitle ?? "",
        relationship.kind ?? "",
        relationship.evidenceKind ?? "",
        relationship.note ?? "",
      ])
      .join(" ") ?? "",
    claims.map((claim) => claim.text).join(" "),
    claims.map((claim) => claim.id ?? "").join(" "),
    claims.map((claim) => claim.evidenceKinds?.join(" ") ?? "").join(" "),
    claims.map((claim) => claim.privacyTiers?.join(" ") ?? "").join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}

function isClaimTextOrIdMatch(
  claim: Pick<QueryDigestClaim, "id" | "text"> | Pick<WikiClaim, "id" | "text">,
  queryLower: string,
  queryTokens: readonly string[] = buildQueryTokens(queryLower),
): boolean {
  const textLower = normalizeLowercaseStringOrEmpty(claim.text);
  if (lineMatchesQuery(textLower, queryLower, [...queryTokens])) {
    return true;
  }
  return lineMatchesQuery(normalizeLowercaseStringOrEmpty(claim.id), queryLower, [...queryTokens]);
}

function scoreClaimMatch(params: {
  text: string;
  id?: string;
  confidence?: number;
  status?: string;
  freshnessLevel?: string;
  queryLower: string;
  queryTokens?: readonly string[];
}): number {
  let score = 0;
  if (normalizeLowercaseStringOrEmpty(params.text).includes(params.queryLower)) {
    score += 25;
  } else if (
    params.queryTokens?.length &&
    params.queryTokens.every((token) =>
      normalizeLowercaseStringOrEmpty(params.text).includes(token),
    )
  ) {
    score += 18;
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
    case undefined:
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
    queryTokens: buildQueryTokens(queryLower),
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

function hasQueryMatch(
  value: string | undefined,
  queryLower: string,
  queryTokens: readonly string[],
) {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  return lineMatchesQuery(normalized, queryLower, [...queryTokens]);
}

function hasAnyQueryMatch(
  values: readonly (string | undefined)[],
  queryLower: string,
  queryTokens: readonly string[],
) {
  return values.some((value) => hasQueryMatch(value, queryLower, queryTokens));
}

function buildPageRouteQuestionFields(page: QueryableWikiPage): string[] {
  return [
    page.personCard?.lane,
    ...(page.personCard?.askFor ?? []),
    ...(page.personCard?.avoidAskingFor ?? []),
    ...page.bestUsedFor,
    ...page.notEnoughFor,
    ...(page.personCard?.bestUsedFor ?? []),
    ...(page.personCard?.notEnoughFor ?? []),
    ...page.relationships.flatMap((relationship) => [
      relationship.kind,
      relationship.targetTitle,
      relationship.note,
    ]),
  ].filter((value): value is string => Boolean(value));
}

function buildDigestRouteQuestionFields(page: QueryDigestPage): string[] {
  return [
    page.personCard?.lane,
    ...(page.personCard?.askFor ?? []),
    ...(page.personCard?.avoidAskingFor ?? []),
    ...(page.bestUsedFor ?? []),
    ...(page.notEnoughFor ?? []),
    ...(page.personCard?.bestUsedFor ?? []),
    ...(page.personCard?.notEnoughFor ?? []),
    ...(page.topRelationships?.flatMap((relationship) => [
      relationship.kind,
      relationship.targetTitle,
      relationship.note,
    ]) ?? []),
  ].filter((value): value is string => Boolean(value));
}

function hasRouteQuestionMatch(values: readonly string[], queryLower: string): boolean {
  return hasAnyQueryMatch(values, queryLower, buildRouteQuestionTokens(queryLower));
}

function isPersonLikeSummary(
  page: Pick<WikiPageSummary, "entityType" | "pageType" | "personCard">,
): boolean {
  const entityType = normalizeLowercaseStringOrEmpty(page.entityType);
  const pageType = normalizeLowercaseStringOrEmpty(page.pageType);
  return (
    Boolean(page.personCard) ||
    entityType === "person" ||
    entityType === "maintainer" ||
    pageType === "person" ||
    pageType === "maintainer"
  );
}

function scorePageSearchModeBoost(params: {
  page: QueryableWikiPage;
  matchingClaims: readonly WikiClaim[];
  queryLower: string;
  queryTokens: readonly string[];
  mode: WikiSearchMode;
}): number {
  const { page, queryLower, queryTokens } = params;
  switch (params.mode) {
    case "auto":
      return 0;
    case "find-person": {
      let score = isPersonLikeSummary(page) ? 24 : -4;
      if (
        hasAnyQueryMatch(
          [
            page.canonicalId,
            ...page.aliases,
            page.personCard?.canonicalId,
            ...(page.personCard?.handles ?? []),
            ...(page.personCard?.emails ?? []),
            ...(page.personCard?.socials ?? []),
          ],
          queryLower,
          queryTokens,
        )
      ) {
        score += 24;
      }
      return score;
    }
    case "route-question": {
      let score = isPersonLikeSummary(page) ? 14 : 0;
      if (hasRouteQuestionMatch(buildPageRouteQuestionFields(page), queryLower)) {
        score += 32;
      }
      score += Math.min(8, page.relationships.length * 2);
      return score;
    }
    case "source-evidence": {
      let score = page.kind === "source" ? 22 : 0;
      if (
        hasAnyQueryMatch(
          [
            page.sourcePath,
            ...page.sourceIds,
            ...page.claims.flatMap((claim) =>
              claim.evidence.flatMap((evidence) => [
                evidence.kind,
                evidence.sourceId,
                evidence.path,
                evidence.lines,
                evidence.note,
              ]),
            ),
          ],
          queryLower,
          queryTokens,
        )
      ) {
        score += 30;
      }
      return score;
    }
    case "raw-claim":
      return params.matchingClaims.length > 0 ? 42 : 0;
  }
  return 0;
}

function scoreDigestSearchModeBoost(params: {
  page: QueryDigestPage;
  claims: readonly QueryDigestClaim[];
  matchingClaims: readonly QueryDigestClaim[];
  queryLower: string;
  queryTokens: readonly string[];
  mode: WikiSearchMode;
}): number {
  const { page, queryLower, queryTokens } = params;
  switch (params.mode) {
    case "auto":
      return 0;
    case "find-person": {
      let score = isPersonLikeSummary(page) ? 24 : -4;
      if (
        hasAnyQueryMatch(
          [
            page.canonicalId,
            ...(page.aliases ?? []),
            page.personCard?.canonicalId,
            ...(page.personCard?.handles ?? []),
            ...(page.personCard?.emails ?? []),
            ...(page.personCard?.socials ?? []),
          ],
          queryLower,
          queryTokens,
        )
      ) {
        score += 24;
      }
      return score;
    }
    case "route-question": {
      let score = isPersonLikeSummary(page) ? 14 : 0;
      if (hasRouteQuestionMatch(buildDigestRouteQuestionFields(page), queryLower)) {
        score += 32;
      }
      score += Math.min(8, (page.relationshipCount ?? 0) * 2);
      return score;
    }
    case "source-evidence": {
      let score = page.kind === "source" ? 22 : 0;
      if (
        hasAnyQueryMatch(
          [
            ...page.sourceIds,
            ...params.claims.flatMap((claim) => [
              ...(claim.sourceIds ?? []),
              ...(claim.evidenceKinds ?? []),
              ...(claim.privacyTiers ?? []),
            ]),
          ],
          queryLower,
          queryTokens,
        )
      ) {
        score += 30;
      }
      return score;
    }
    case "raw-claim":
      return params.matchingClaims.length > 0 ? 42 : 0;
  }
  return 0;
}

function buildDigestCandidatePaths(params: {
  digest: QueryDigestBundle;
  query: string;
  maxResults: number;
  mode: WikiSearchMode;
}): string[] {
  const queryLower = normalizeLowercaseStringOrEmpty(params.query);
  const queryTokens = buildQueryTokens(queryLower);
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
      if (
        !metadataLower.includes(queryLower) &&
        !(
          params.mode === "route-question" &&
          hasRouteQuestionMatch(buildDigestRouteQuestionFields(page), queryLower)
        )
      ) {
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
        .filter((claim) => isClaimTextOrIdMatch(claim, queryLower, queryTokens))
        .toSorted(
          (left, right) =>
            scoreDigestClaimMatch(right, queryLower) - scoreDigestClaimMatch(left, queryLower),
        );
      if (matchingClaims.length > 0) {
        score += scoreDigestClaimMatch(matchingClaims[0], queryLower);
        score += Math.min(10, (matchingClaims.length - 1) * 2);
      }
      score += scoreDigestSearchModeBoost({
        page,
        claims,
        matchingClaims,
        queryLower,
        queryTokens,
        mode: params.mode,
      });
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

function isClaimMatch(
  claim: WikiClaim,
  queryLower: string,
  queryTokens: readonly string[],
): boolean {
  return isClaimTextOrIdMatch(claim, queryLower, queryTokens);
}

function rankClaimMatch(
  page: QueryableWikiPage,
  claim: WikiClaim,
  queryLower: string,
  queryTokens: readonly string[],
): number {
  const freshness = assessClaimFreshness({ page, claim });
  return scoreClaimMatch({
    text: claim.text,
    id: claim.id,
    confidence: claim.confidence,
    status: claim.status,
    freshnessLevel: freshness.level,
    queryLower,
    queryTokens,
  });
}

function getMatchingClaims(page: QueryableWikiPage, queryLower: string): WikiClaim[] {
  const queryTokens = buildQueryTokens(queryLower);
  return page.claims
    .filter((claim) => isClaimMatch(claim, queryLower, queryTokens))
    .toSorted(
      (left, right) =>
        rankClaimMatch(page, right, queryLower, queryTokens) -
        rankClaimMatch(page, left, queryLower, queryTokens),
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

function scorePage(page: QueryableWikiPage, query: string, mode: WikiSearchMode): number {
  const queryLower = normalizeLowercaseStringOrEmpty(query);
  const queryTokens = buildQueryTokens(queryLower);
  const titleLower = normalizeLowercaseStringOrEmpty(page.title);
  const pathLower = normalizeLowercaseStringOrEmpty(page.relativePath);
  const idLower = normalizeLowercaseStringOrEmpty(page.id);
  const metadataLower = normalizeLowercaseStringOrEmpty(buildPageSearchText(page));
  const rawLower = normalizeLowercaseStringOrEmpty(stripGeneratedRelatedBlock(page.raw));
  const combinedLower = [titleLower, pathLower, idLower, metadataLower, rawLower].join("\n");
  const hasExactMatch =
    titleLower.includes(queryLower) ||
    pathLower.includes(queryLower) ||
    idLower.includes(queryLower) ||
    metadataLower.includes(queryLower) ||
    rawLower.includes(queryLower);
  const hasAllTokens =
    queryTokens.length > 0 && queryTokens.every((token) => combinedLower.includes(token));
  const hasModeMatch =
    mode === "route-question" &&
    hasRouteQuestionMatch(buildPageRouteQuestionFields(page), queryLower);
  if (!hasExactMatch && !hasAllTokens && !hasModeMatch) {
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
    score += rankClaimMatch(page, matchingClaims[0], queryLower, queryTokens);
    score += Math.min(10, (matchingClaims.length - 1) * 2);
  }
  score += scorePageSearchModeBoost({
    page,
    matchingClaims,
    queryLower,
    queryTokens,
    mode,
  });
  const bodyOccurrences = rawLower.split(queryLower).length - 1;
  score += Math.min(10, bodyOccurrences);
  for (const token of queryTokens) {
    if (titleLower.includes(token)) {
      score += 8;
    }
    if (pathLower.includes(token) || idLower.includes(token)) {
      score += 6;
    }
    if (metadataLower.includes(token)) {
      score += 4;
    }
    if (rawLower.includes(token)) {
      score += 1;
    }
  }
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

function shouldEnforceSessionVisibility(params: {
  agentSessionKey?: string;
  sandboxed?: boolean;
}): boolean {
  return params.sandboxed === true || Boolean(params.agentSessionKey?.trim());
}

function shouldSearchSharedMemoryCorpus(config: ResolvedMemoryWikiConfig): boolean {
  return config.search.corpus === "memory" || config.search.corpus === "all";
}

function shouldUseSharedMemory(config: ResolvedMemoryWikiConfig): boolean {
  return config.search.backend === "shared" && shouldSearchSharedMemoryCorpus(config);
}

function assertSessionVisibilityAppConfig(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  agentSessionKey?: string;
  sandboxed?: boolean;
  operation: string;
}): void {
  if (
    shouldUseSharedMemory(params.config) &&
    shouldEnforceSessionVisibility(params) &&
    !params.appConfig
  ) {
    throw new Error(
      `${params.operation} requires appConfig to enforce session visibility for session-bound shared memory calls.`,
    );
  }
}

const SESSION_MEMORY_PATH_PREFIXES = ["sessions/", "qmd/sessions/", "qmd/sessions-"] as const;
const SESSION_MEMORY_ROOT_PATHS = ["qmd/sessions"] as const;

// Keep these path shapes aligned with source: "sessions" hits in session-search-visibility and session-transcript-hit.
export function isSessionMemoryPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return (
    SESSION_MEMORY_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    SESSION_MEMORY_ROOT_PATHS.some((rootPath) => normalized === rootPath)
  );
}

function shouldSearchWiki(config: ResolvedMemoryWikiConfig): boolean {
  return config.search.corpus === "wiki" || config.search.corpus === "all";
}

function shouldSearchSharedMemory(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): boolean {
  return shouldUseSharedMemory(config) && appConfig !== undefined;
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
    | "entityType"
    | "canonicalId"
    | "aliases"
    | "privacyTier"
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
    | "entityType"
    | "canonicalId"
    | "aliases"
    | "privacyTier"
  >,
): Partial<
  Pick<
    WikiSearchResult,
    | "id"
    | "sourceType"
    | "provenanceMode"
    | "sourcePath"
    | "provenanceLabel"
    | "updatedAt"
    | "entityType"
    | "canonicalId"
    | "aliases"
    | "privacyTier"
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
    ...("entityType" in page && page.entityType ? { entityType: page.entityType } : {}),
    ...("canonicalId" in page && page.canonicalId ? { canonicalId: page.canonicalId } : {}),
    ...("aliases" in page && page.aliases.length > 0 ? { aliases: [...page.aliases] } : {}),
    ...("privacyTier" in page && page.privacyTier ? { privacyTier: page.privacyTier } : {}),
  };
}

function buildClaimResultMetadata(claim: WikiClaim | undefined): Partial<WikiSearchResult> {
  if (!claim) {
    return {};
  }
  return {
    ...(claim.id ? { matchedClaimId: claim.id } : {}),
    ...(claim.status ? { matchedClaimStatus: claim.status } : {}),
    ...(typeof claim.confidence === "number" ? { matchedClaimConfidence: claim.confidence } : {}),
    evidenceKinds: [...new Set(claim.evidence.flatMap((evidence) => evidence.kind ?? []))],
    evidenceSourceIds: [...new Set(claim.evidence.flatMap((evidence) => evidence.sourceId ?? []))],
  };
}

function toWikiSearchResult(
  page: QueryableWikiPage,
  query: string,
  mode: WikiSearchMode,
): WikiSearchResult {
  const queryLower = normalizeLowercaseStringOrEmpty(query);
  const matchingClaim = getMatchingClaims(page, queryLower)[0];
  return {
    corpus: "wiki",
    path: page.relativePath,
    title: page.title,
    kind: page.kind,
    score: scorePage(page, query, mode),
    snippet: buildPageSnippet(page, query),
    searchMode: mode,
    ...buildWikiResultMetadata(page),
    ...buildClaimResultMetadata(matchingClaim),
  };
}

function toMemoryWikiSearchResult(
  result: MemorySearchResult,
  mode: WikiSearchMode,
): WikiSearchResult {
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
    searchMode: mode,
    ...(result.citation ? { citation: result.citation } : {}),
  };
}

async function filterMemoryWikiSearchHitsBySessionVisibility(params: {
  cfg: OpenClawConfig;
  requesterSessionKey: string | undefined;
  sandboxed: boolean;
  hits: MemorySearchResult[];
}): Promise<MemorySearchResult[]> {
  if (!params.hits.some((hit) => hit.source === "sessions")) {
    return params.hits;
  }

  const canReadSessionPath = await createSessionMemoryPathVisibilityChecker({
    cfg: params.cfg,
    requesterSessionKey: params.requesterSessionKey,
    sandboxed: params.sandboxed,
  });
  return filterMemoryWikiSearchHitsWithSessionVisibility({
    canReadSessionPath,
    hits: params.hits,
  });
}

type SessionMemoryPathVisibilityChecker = (relPath: string) => boolean;

async function createSessionMemoryPathVisibilityChecker(params: {
  cfg: OpenClawConfig;
  requesterSessionKey: string | undefined;
  sandboxed: boolean;
}): Promise<SessionMemoryPathVisibilityChecker> {
  const visibility = resolveEffectiveSessionToolsVisibility({
    cfg: params.cfg,
    sandboxed: params.sandboxed,
  });
  const a2aPolicy = createAgentToAgentPolicy(params.cfg);
  const guard = params.requesterSessionKey
    ? await createSessionVisibilityGuard({
        action: "history",
        requesterSessionKey: params.requesterSessionKey,
        visibility,
        a2aPolicy,
      })
    : null;
  if (!guard) {
    return () => false;
  }

  const { store: combinedSessionStore } = loadCombinedSessionStoreForGateway(params.cfg);
  return (relPath) => {
    const stem = extractTranscriptStemFromSessionsMemoryHit(relPath);
    if (!stem) {
      return false;
    }
    const keys = resolveTranscriptStemToSessionKeys({
      store: combinedSessionStore,
      stem,
    });
    return keys.some((key) => guard.check(key).allowed);
  };
}

function filterMemoryWikiSearchHitsWithSessionVisibility(params: {
  canReadSessionPath: SessionMemoryPathVisibilityChecker;
  hits: MemorySearchResult[];
}): MemorySearchResult[] {
  const next: MemorySearchResult[] = [];
  for (const hit of params.hits) {
    if (hit.source !== "sessions") {
      next.push(hit);
      continue;
    }

    if (params.canReadSessionPath(hit.path)) {
      next.push(hit);
    }
  }
  return next;
}

function canReadSessionMemoryPath(params: {
  canReadSessionPath: SessionMemoryPathVisibilityChecker;
  relPath: string;
}): boolean {
  // Reuses the search filter with a synthetic hit; update this if the filter needs more than path/source.
  const filtered = filterMemoryWikiSearchHitsWithSessionVisibility({
    canReadSessionPath: params.canReadSessionPath,
    hits: [
      {
        path: params.relPath,
        startLine: 1,
        endLine: 1,
        score: 0,
        snippet: "",
        source: "sessions",
      },
    ],
  });
  return filtered.length > 0;
}

async function searchWikiCorpus(params: {
  rootDir: string;
  query: string;
  maxResults: number;
  mode: WikiSearchMode;
}): Promise<WikiSearchResult[]> {
  const digest = await readQueryDigestBundle(params.rootDir);
  const candidatePaths = digest
    ? buildDigestCandidatePaths({
        digest,
        query: params.query,
        maxResults: params.maxResults,
        mode: params.mode,
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
    .map((page) => toWikiSearchResult(page, params.query, params.mode))
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
      .map((page) => toWikiSearchResult(page, params.query, params.mode))
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
  sandboxed?: boolean;
  query: string;
  maxResults?: number;
  searchBackend?: WikiSearchBackend;
  searchCorpus?: WikiSearchCorpus;
  mode?: WikiSearchMode;
}): Promise<WikiSearchResult[]> {
  const effectiveConfig = applySearchOverrides(params.config, params);
  assertSessionVisibilityAppConfig({
    config: effectiveConfig,
    appConfig: params.appConfig,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
    operation: "wiki_search",
  });
  await initializeMemoryWikiVault(effectiveConfig);
  const maxResults = Math.max(1, params.maxResults ?? 10);
  const mode = params.mode ?? "auto";

  const wikiResults = shouldSearchWiki(effectiveConfig)
    ? await searchWikiCorpus({
        rootDir: effectiveConfig.vault.path,
        query: params.query,
        maxResults,
        mode,
      })
    : [];

  const sharedMemoryManager = shouldSearchSharedMemory(effectiveConfig, params.appConfig)
    ? await resolveActiveMemoryManager({
        appConfig: params.appConfig,
        agentId: params.agentId,
        agentSessionKey: params.agentSessionKey,
      })
    : null;
  let rawMemoryResults = sharedMemoryManager
    ? await sharedMemoryManager.search(params.query, { maxResults })
    : [];
  if (
    params.appConfig &&
    shouldEnforceSessionVisibility(params) &&
    rawMemoryResults.some((hit) => hit.source === "sessions")
  ) {
    rawMemoryResults = await filterMemoryWikiSearchHitsBySessionVisibility({
      cfg: params.appConfig,
      requesterSessionKey: params.agentSessionKey,
      sandboxed: params.sandboxed === true,
      hits: rawMemoryResults,
    });
  }
  const memoryResults = rawMemoryResults.map((result) => toMemoryWikiSearchResult(result, mode));

  return mergeWikiSearchCorpusResults({
    wikiResults,
    memoryResults,
    maxResults,
    balanceCorpora: effectiveConfig.search.corpus === "all",
  });
}

export async function getMemoryWikiPage(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  lookup: string;
  fromLine?: number;
  lineCount?: number;
  searchBackend?: WikiSearchBackend;
  searchCorpus?: WikiSearchCorpus;
}): Promise<WikiGetResult | null> {
  const effectiveConfig = applySearchOverrides(params.config, params);
  assertSessionVisibilityAppConfig({
    config: effectiveConfig,
    appConfig: params.appConfig,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
    operation: "wiki_get",
  });
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

  const lookupCandidates = buildLookupCandidates(params.lookup);
  const canReadSessionPath =
    params.appConfig &&
    shouldEnforceSessionVisibility(params) &&
    lookupCandidates.some((relPath) => isSessionMemoryPath(relPath))
      ? await createSessionMemoryPathVisibilityChecker({
          cfg: params.appConfig,
          requesterSessionKey: params.agentSessionKey,
          sandboxed: params.sandboxed === true,
        })
      : null;

  for (const relPath of lookupCandidates) {
    if (
      canReadSessionPath &&
      isSessionMemoryPath(relPath) &&
      !canReadSessionMemoryPath({
        canReadSessionPath,
        relPath,
      })
    ) {
      continue;
    }

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
