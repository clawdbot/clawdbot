// Memory Wiki plugin module implements the memory wiki overview.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { loadMemoryWikiCompiledCache } from "./compiled-cache.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import type {
  MemoryWikiOverviewCluster,
  MemoryWikiOverviewItem,
  MemoryWikiOverviewPageCounts,
  MemoryWikiOverviewStatus,
} from "./dashboard-types.js";
import {
  parseWikiMarkdown,
  type ParsedWikiMarkdown,
  type WikiPageKind,
  type WikiPageSummary,
} from "./markdown.js";
import { readQueryableWikiPages } from "./query.js";

const OVERVIEW_KIND_ORDER: WikiPageKind[] = ["synthesis", "entity", "concept", "source", "report"];
const PRIMARY_OVERVIEW_KINDS = new Set<WikiPageKind>(["synthesis", "entity", "concept"]);
const OVERVIEW_KIND_LABELS: Record<WikiPageKind, string> = {
  synthesis: "Syntheses",
  entity: "Entities",
  concept: "Concepts",
  source: "Sources",
  report: "Reports",
};

function createEmptyOverviewPageCounts(): MemoryWikiOverviewPageCounts {
  return {
    synthesis: 0,
    entity: 0,
    concept: 0,
    source: 0,
    report: 0,
  };
}

function extractSnippet(body: string): string | undefined {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      !line ||
      line.startsWith("#") ||
      line.startsWith("```") ||
      line.startsWith("<!--") ||
      line.startsWith("- ") ||
      line.startsWith("* ")
    ) {
      continue;
    }
    return line;
  }
  return undefined;
}

function compareOverviewItems(left: MemoryWikiOverviewItem, right: MemoryWikiOverviewItem): number {
  const leftKey = left.updatedAt ?? "";
  const rightKey = right.updatedAt ?? "";
  if (rightKey !== leftKey) {
    return rightKey.localeCompare(leftKey);
  }
  if (right.claimCount !== left.claimCount) {
    return right.claimCount - left.claimCount;
  }
  return left.title.localeCompare(right.title);
}

export async function listMemoryWikiOverview(
  config: ResolvedMemoryWikiConfig,
): Promise<MemoryWikiOverviewStatus> {
  const compiled = await loadMemoryWikiCompiledCache(config).catch(() => null);
  if (compiled) {
    const pageCounts = createEmptyOverviewPageCounts();
    let totalClaims = 0;
    let totalQuestions = 0;
    let totalContradictions = 0;
    const items = compiled.digest.pages.flatMap((page) => {
      pageCounts[page.kind] += 1;
      totalClaims += page.claimCount;
      totalQuestions += page.questions.length;
      totalContradictions += page.contradictions.length;
      return page.dashboard?.overview ? [page.dashboard.overview] : [];
    });
    return buildMemoryWikiOverviewStatus({
      items,
      totalPages: compiled.digest.pages.length,
      pageCounts,
      totalClaims,
      totalQuestions,
      totalContradictions,
    });
  }
  const pages = await readQueryableWikiPages(config.vault.path);
  const pageCounts = pages.reduce<MemoryWikiOverviewPageCounts>((counts, page) => {
    counts[page.kind] += 1;
    return counts;
  }, createEmptyOverviewPageCounts());
  const totalClaims = pages.reduce((sum, page) => sum + page.claims.length, 0);
  const totalQuestions = pages.reduce((sum, page) => sum + page.questions.length, 0);
  const totalContradictions = pages.reduce((sum, page) => sum + page.contradictions.length, 0);
  const items = pages
    .map((page) => buildMemoryWikiOverviewItem({ page, parsed: parseWikiMarkdown(page.raw) }))
    .filter(
      (item) =>
        PRIMARY_OVERVIEW_KINDS.has(item.kind) ||
        item.claimCount > 0 ||
        item.questionCount > 0 ||
        item.contradictionCount > 0,
    )
    .toSorted(compareOverviewItems);

  return buildMemoryWikiOverviewStatus({
    items,
    totalPages: pages.length,
    pageCounts,
    totalClaims,
    totalQuestions,
    totalContradictions,
  });
}

function buildMemoryWikiOverviewStatus(params: {
  items: MemoryWikiOverviewItem[];
  totalPages: number;
  pageCounts: MemoryWikiOverviewPageCounts;
  totalClaims: number;
  totalQuestions: number;
  totalContradictions: number;
}): MemoryWikiOverviewStatus {
  const items = params.items;
  const clusters = OVERVIEW_KIND_ORDER.map((kind) => {
    const clusterItems = items.filter((item) => item.kind === kind);
    if (clusterItems.length === 0) {
      return null;
    }
    return Object.assign(
      {
        key: kind,
        label: OVERVIEW_KIND_LABELS[kind],
        itemCount: clusterItems.length,
        claimCount: clusterItems.reduce((sum, item) => sum + item.claimCount, 0),
        questionCount: clusterItems.reduce((sum, item) => sum + item.questionCount, 0),
        contradictionCount: clusterItems.reduce((sum, item) => sum + item.contradictionCount, 0),
      },
      clusterItems[0]?.updatedAt ? { updatedAt: clusterItems[0].updatedAt } : {},
      { items: clusterItems },
    ) satisfies MemoryWikiOverviewCluster;
  }).filter((entry): entry is MemoryWikiOverviewCluster => entry !== null);

  return {
    totalItems: items.length,
    totalPages: params.totalPages,
    pageCounts: params.pageCounts,
    totalClaims: params.totalClaims,
    totalQuestions: params.totalQuestions,
    totalContradictions: params.totalContradictions,
    clusters,
  };
}

export function buildMemoryWikiOverviewItem(params: {
  page: WikiPageSummary;
  parsed: ParsedWikiMarkdown;
}): MemoryWikiOverviewItem {
  const { page, parsed } = params;
  const updatedAt = normalizeOptionalString(page.updatedAt);
  const sourceType = normalizeOptionalString(page.sourceType);
  return Object.assign(
    { pagePath: page.relativePath, title: page.title, kind: page.kind },
    page.id ? { id: page.id } : {},
    updatedAt ? { updatedAt } : {},
    sourceType ? { sourceType } : {},
    {
      claimCount: page.claims.length,
      questionCount: page.questions.length,
      contradictionCount: page.contradictions.length,
      claims: page.claims.map((claim) => claim.text).slice(0, 3),
      questions: page.questions.slice(0, 3),
      contradictions: page.contradictions.slice(0, 3),
    },
    extractSnippet(parsed.body) ? { snippet: extractSnippet(parsed.body) } : {},
  ) satisfies MemoryWikiOverviewItem;
}
