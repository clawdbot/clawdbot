// Memory Wiki plugin module implements memory palace behavior.
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { parseWikiMarkdown, type WikiPageKind } from "./markdown.js";
import { readQueryableWikiPages } from "./query.js";

const PALACE_KIND_ORDER: WikiPageKind[] = ["synthesis", "entity", "concept", "source", "report"];
const PRIMARY_PALACE_KINDS = new Set<WikiPageKind>(["synthesis", "entity", "concept"]);
const PALACE_KIND_LABELS: Record<WikiPageKind, string> = {
  synthesis: "Syntheses",
  entity: "Entities",
  concept: "Concepts",
  source: "Sources",
  report: "Reports",
};

type MemoryWikiPalaceItem = {
  pagePath: string;
  title: string;
  kind: WikiPageKind;
  id?: string;
  updatedAt?: string;
  sourceType?: string;
  claimCount: number;
  questionCount: number;
  contradictionCount: number;
  claims: string[];
  questions: string[];
  contradictions: string[];
  snippet?: string;
};

type MemoryWikiPalaceCluster = {
  key: WikiPageKind;
  label: string;
  itemCount: number;
  claimCount: number;
  questionCount: number;
  contradictionCount: number;
  updatedAt?: string;
  items: MemoryWikiPalaceItem[];
};

type MemoryWikiPalacePageCounts = Record<WikiPageKind, number>;

type MemoryWikiPalaceStatus = {
  totalItems: number;
  totalPages: number;
  pageCounts: MemoryWikiPalacePageCounts;
  totalClaims: number;
  totalQuestions: number;
  totalContradictions: number;
  clusters: MemoryWikiPalaceCluster[];
};

function createEmptyPalacePageCounts(): MemoryWikiPalacePageCounts {
  return {
    synthesis: 0,
    entity: 0,
    concept: 0,
    source: 0,
    report: 0,
  };
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

function comparePalaceItems(left: MemoryWikiPalaceItem, right: MemoryWikiPalaceItem): number {
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

export async function listMemoryWikiPalace(
  config: ResolvedMemoryWikiConfig,
): Promise<MemoryWikiPalaceStatus> {
  const pages = await readQueryableWikiPages(config.vault.path);
  const pageCounts = pages.reduce<MemoryWikiPalacePageCounts>((counts, page) => {
    counts[page.kind] += 1;
    return counts;
  }, createEmptyPalacePageCounts());
  const totalClaims = pages.reduce((sum, page) => sum + page.claims.length, 0);
  const totalQuestions = pages.reduce((sum, page) => sum + page.questions.length, 0);
  const totalContradictions = pages.reduce((sum, page) => sum + page.contradictions.length, 0);
  const items = pages
    .map((page) => {
      const parsed = parseWikiMarkdown(page.raw);
      return Object.assign(
        { pagePath: page.relativePath, title: page.title, kind: page.kind },
        page.id ? { id: page.id } : {},
        normalizeTimestamp(page.updatedAt) ? { updatedAt: normalizeTimestamp(page.updatedAt) } : {},
        typeof page.sourceType === `string` && page.sourceType.trim().length > 0
          ? { sourceType: page.sourceType.trim() }
          : {},
        {
          claimCount: page.claims.length,
          questionCount: page.questions.length,
          contradictionCount: page.contradictions.length,
          claims: page.claims.map((claim) => claim.text).slice(0, 3),
          questions: page.questions.slice(0, 3),
          contradictions: page.contradictions.slice(0, 3),
        },
        extractSnippet(parsed.body) ? { snippet: extractSnippet(parsed.body) } : {},
      ) satisfies MemoryWikiPalaceItem;
    })
    .filter(
      (item) =>
        PRIMARY_PALACE_KINDS.has(item.kind) ||
        item.claimCount > 0 ||
        item.questionCount > 0 ||
        item.contradictionCount > 0,
    )
    .toSorted(comparePalaceItems);

  const clusters = PALACE_KIND_ORDER.map((kind) => {
    const clusterItems = items.filter((item) => item.kind === kind);
    if (clusterItems.length === 0) {
      return null;
    }
    return Object.assign(
      {
        key: kind,
        label: PALACE_KIND_LABELS[kind],
        itemCount: clusterItems.length,
        claimCount: clusterItems.reduce((sum, item) => sum + item.claimCount, 0),
        questionCount: clusterItems.reduce((sum, item) => sum + item.questionCount, 0),
        contradictionCount: clusterItems.reduce((sum, item) => sum + item.contradictionCount, 0),
      },
      clusterItems[0]?.updatedAt ? { updatedAt: clusterItems[0].updatedAt } : {},
      { items: clusterItems },
    ) satisfies MemoryWikiPalaceCluster;
  }).filter((entry): entry is MemoryWikiPalaceCluster => entry !== null);

  return {
    totalItems: items.length,
    totalPages: pages.length,
    pageCounts,
    totalClaims,
    totalQuestions,
    totalContradictions,
    clusters,
  };
}
