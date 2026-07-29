// Memory Wiki plugin module enumerates unresolved open items for review and resolution.
import {
  buildClaimContradictionClusters,
  buildPageContradictionClusters,
  collectWikiClaimHealth,
} from "./claim-health.js";
import type { WikiPageSummary } from "./markdown.js";
import { readQueryableWikiPages } from "./query.js";

export const WIKI_OPEN_ITEM_KINDS = [
  "open-question",
  "page-contradiction",
  "claim-contradiction",
  "low-confidence-page",
  "low-confidence-claim",
] as const;

export type MemoryWikiOpenItemKind = (typeof WIKI_OPEN_ITEM_KINDS)[number];

// Mirrors the low-confidence dashboard threshold in compile.ts so the tool and
// the reports/low-confidence.md dashboard stay in agreement.
const LOW_CONFIDENCE_THRESHOLD = 0.5;

// One competing statement inside a contradiction cluster. Carried on the item so
// agents (and downstream resolution flows) can present the actual conflicting
// claims instead of an opaque cluster id.
export type MemoryWikiOpenItemVariant = {
  text: string;
  status: string;
  pagePath: string;
  pageTitle: string;
  confidence?: number;
};

export type MemoryWikiOpenItem = {
  kind: MemoryWikiOpenItemKind;
  text: string;
  pagePath: string;
  pageTitle: string;
  pageId?: string;
  claimId?: string;
  confidence?: number;
  variants?: MemoryWikiOpenItemVariant[];
  relatedPagePaths?: string[];
};

export type MemoryWikiOpenItemCounts = Record<MemoryWikiOpenItemKind, number> & { total: number };

export type MemoryWikiOpenItemsResult = {
  items: MemoryWikiOpenItem[];
  counts: MemoryWikiOpenItemCounts;
};

/** Tally a list of open items by kind (plus a grand total). */
export function countMemoryWikiOpenItems(items: MemoryWikiOpenItem[]): MemoryWikiOpenItemCounts {
  const counts: MemoryWikiOpenItemCounts = {
    "open-question": 0,
    "page-contradiction": 0,
    "claim-contradiction": 0,
    "low-confidence-page": 0,
    "low-confidence-claim": 0,
    total: 0,
  };
  for (const item of items) {
    counts[item.kind] += 1;
    counts.total += 1;
  }
  return counts;
}

/**
 * Derive the unresolved open items (open questions, contradiction clusters, and
 * low-confidence pages/claims) from already-loaded page summaries. Pure so it can
 * be unit tested without touching the filesystem; the detection logic reuses the
 * same helpers that power the reports/*.md dashboards in compile.ts.
 */
export function deriveMemoryWikiOpenItems(
  pages: WikiPageSummary[],
  now?: Date,
): MemoryWikiOpenItemsResult {
  const items: MemoryWikiOpenItem[] = [];

  // Open questions — one item per question string (mirrors reports/open-questions.md).
  for (const page of pages) {
    for (const question of page.questions) {
      items.push({
        kind: "open-question",
        text: question,
        pagePath: page.relativePath,
        pageTitle: page.title,
        ...(page.id ? { pageId: page.id } : {}),
      });
    }
  }

  // Page-level contradiction note clusters.
  for (const cluster of buildPageContradictionClusters(pages)) {
    const first = cluster.entries[0];
    items.push({
      kind: "page-contradiction",
      text: cluster.label,
      pagePath: first?.pagePath ?? "",
      pageTitle: first?.pageTitle ?? "",
      ...(first?.pageId ? { pageId: first.pageId } : {}),
      relatedPagePaths: cluster.entries.map((entry) => entry.pagePath),
    });
  }

  // Competing-claim clusters (same claim id, divergent text/status across pages).
  // cluster.label is only the shared claim id, so build the item text from the
  // actual conflicting statements and carry each variant as structured data.
  for (const cluster of buildClaimContradictionClusters({ pages, now })) {
    const first = cluster.entries[0];
    const variants: MemoryWikiOpenItemVariant[] = cluster.entries.map((entry) => ({
      text: entry.text,
      status: entry.status,
      pagePath: entry.pagePath,
      pageTitle: entry.pageTitle,
      ...(typeof entry.confidence === "number" ? { confidence: entry.confidence } : {}),
    }));
    const seen = new Set<string>();
    const summaryParts: string[] = [];
    for (const variant of variants) {
      const key = `${variant.text} ${variant.status}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      summaryParts.push(`"${variant.text}" [${variant.status}]`);
    }
    items.push({
      kind: "claim-contradiction",
      text: summaryParts.join(" vs "),
      pagePath: first?.pagePath ?? "",
      pageTitle: first?.pageTitle ?? "",
      ...(first?.pageId ? { pageId: first.pageId } : {}),
      claimId: cluster.key,
      variants,
      relatedPagePaths: cluster.entries.map((entry) => entry.pagePath),
    });
  }

  // Low-confidence pages.
  for (const page of pages) {
    if (typeof page.confidence === "number" && page.confidence < LOW_CONFIDENCE_THRESHOLD) {
      items.push({
        kind: "low-confidence-page",
        text: page.title,
        pagePath: page.relativePath,
        pageTitle: page.title,
        ...(page.id ? { pageId: page.id } : {}),
        confidence: page.confidence,
      });
    }
  }

  // Low-confidence claims.
  for (const claim of collectWikiClaimHealth(pages, now)) {
    if (typeof claim.confidence === "number" && claim.confidence < LOW_CONFIDENCE_THRESHOLD) {
      items.push({
        kind: "low-confidence-claim",
        text: claim.text,
        pagePath: claim.pagePath,
        pageTitle: claim.pageTitle,
        ...(claim.pageId ? { pageId: claim.pageId } : {}),
        ...(claim.claimId ? { claimId: claim.claimId } : {}),
        confidence: claim.confidence,
      });
    }
  }

  return { items, counts: countMemoryWikiOpenItems(items) };
}

/**
 * Read the vault at `rootDir` and enumerate its unresolved open items.
 */
export async function collectMemoryWikiOpenItems(
  rootDir: string,
  now?: Date,
): Promise<MemoryWikiOpenItemsResult> {
  const pages = await readQueryableWikiPages(rootDir);
  return deriveMemoryWikiOpenItems(pages, now);
}
