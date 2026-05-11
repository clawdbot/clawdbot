import fs from "node:fs/promises";
import path from "node:path";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assessClaimFreshness,
  assessPageFreshness,
  buildClaimContradictionClusters,
  buildPageContradictionClusters,
  collectWikiClaimHealth,
  isClaimContestedStatus,
  normalizeClaimStatus,
  WIKI_AGING_DAYS,
  type WikiClaimContradictionCluster,
  type WikiClaimHealth,
  type WikiFreshness,
  type WikiFreshnessLevel,
  type WikiPageContradictionCluster,
} from "./claim-health.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  formatWikiLink,
  parseWikiMarkdown,
  renderWikiMarkdown,
  toWikiPageSummary,
  type WikiClaim,
  type WikiClaimEvidence,
  type WikiPageKind,
  type WikiPageSummary,
  type WikiRelationship,
  WIKI_RELATED_END_MARKER,
  WIKI_RELATED_START_MARKER,
} from "./markdown.js";
import { initializeMemoryWikiVault } from "./vault.js";

const COMPILE_PAGE_GROUPS: Array<{ kind: WikiPageKind; dir: string; heading: string }> = [
  { kind: "source", dir: "sources", heading: "Sources" },
  { kind: "entity", dir: "entities", heading: "Entities" },
  { kind: "concept", dir: "concepts", heading: "Concepts" },
  { kind: "synthesis", dir: "syntheses", heading: "Syntheses" },
  { kind: "report", dir: "reports", heading: "Reports" },
];
const AGENT_DIGEST_PATH = ".openclaw-wiki/cache/agent-digest.json";
const CLAIMS_DIGEST_PATH = ".openclaw-wiki/cache/claims.jsonl";
const MAX_RELATED_PAGES_PER_SECTION = 12;
const MAX_SHARED_SOURCE_FANOUT = 24;

type DashboardPageDefinition = {
  id: string;
  title: string;
  relativePath: string;
  buildBody: (params: {
    config: ResolvedMemoryWikiConfig;
    pages: WikiPageSummary[];
    now: Date;
  }) => string;
};

const DASHBOARD_PAGES: DashboardPageDefinition[] = [
  {
    id: "report.open-questions",
    title: "Open Questions",
    relativePath: "reports/open-questions.md",
    buildBody: ({ config, pages }) => {
      const matches = pages.filter((page) => page.questions.length > 0);
      if (matches.length === 0) {
        return "- No open questions right now.";
      }
      return [
        `- Pages with open questions: ${matches.length}`,
        "",
        ...matches.map(
          (page) =>
            `- ${formatWikiLink({
              renderMode: config.vault.renderMode,
              relativePath: page.relativePath,
              title: page.title,
            })}: ${page.questions.join(" | ")}`,
        ),
      ].join("\n");
    },
  },
  {
    id: "report.contradictions",
    title: "Contradictions",
    relativePath: "reports/contradictions.md",
    buildBody: ({ config, pages, now }) => {
      const pageClusters = buildPageContradictionClusters(pages);
      const claimClusters = buildClaimContradictionClusters({ pages, now });
      if (pageClusters.length === 0 && claimClusters.length === 0) {
        return "- No contradictions flagged right now.";
      }
      const lines = [
        `- Contradiction note clusters: ${pageClusters.length}`,
        `- Competing claim clusters: ${claimClusters.length}`,
      ];
      if (pageClusters.length > 0) {
        lines.push("", "### Page Notes");
        for (const cluster of pageClusters) {
          lines.push(formatPageContradictionClusterLine(config, cluster));
        }
      }
      if (claimClusters.length > 0) {
        lines.push("", "### Claim Clusters");
        for (const cluster of claimClusters) {
          lines.push(formatClaimContradictionClusterLine(config, cluster));
        }
      }
      return lines.join("\n");
    },
  },
  {
    id: "report.low-confidence",
    title: "Low Confidence",
    relativePath: "reports/low-confidence.md",
    buildBody: ({ config, pages, now }) => {
      const pageMatches = pages
        .filter((page) => typeof page.confidence === "number" && page.confidence < 0.5)
        .toSorted((left, right) => (left.confidence ?? 1) - (right.confidence ?? 1));
      const claimMatches = collectWikiClaimHealth(pages, now)
        .filter((claim) => typeof claim.confidence === "number" && claim.confidence < 0.5)
        .toSorted((left, right) => (left.confidence ?? 1) - (right.confidence ?? 1));
      if (pageMatches.length === 0 && claimMatches.length === 0) {
        return "- No low-confidence pages or claims right now.";
      }
      const lines = [
        `- Low-confidence pages: ${pageMatches.length}`,
        `- Low-confidence claims: ${claimMatches.length}`,
      ];
      if (pageMatches.length > 0) {
        lines.push("", "### Pages");
        for (const page of pageMatches) {
          lines.push(
            `- ${formatPageLink(config, page)}: confidence ${(page.confidence ?? 0).toFixed(2)}`,
          );
        }
      }
      if (claimMatches.length > 0) {
        lines.push("", "### Claims");
        for (const claim of claimMatches) {
          lines.push(`- ${formatClaimHealthLine(config, claim)}`);
        }
      }
      return lines.join("\n");
    },
  },
  {
    id: "report.claim-health",
    title: "Claim Health",
    relativePath: "reports/claim-health.md",
    buildBody: ({ config, pages, now }) => {
      const claimHealth = collectWikiClaimHealth(pages, now);
      const missingEvidence = claimHealth.filter((claim) => claim.missingEvidence);
      const contestedClaims = claimHealth.filter((claim) => isClaimHealthContested(claim));
      const staleClaims = claimHealth.filter(
        (claim) => claim.freshness.level === "stale" || claim.freshness.level === "unknown",
      );
      if (
        missingEvidence.length === 0 &&
        contestedClaims.length === 0 &&
        staleClaims.length === 0
      ) {
        return "- No claim health issues right now.";
      }
      const lines = [
        `- Claims missing evidence: ${missingEvidence.length}`,
        `- Contested claims: ${contestedClaims.length}`,
        `- Stale or unknown claims: ${staleClaims.length}`,
      ];
      if (missingEvidence.length > 0) {
        lines.push("", "### Missing Evidence");
        for (const claim of missingEvidence) {
          lines.push(`- ${formatClaimHealthLine(config, claim)}`);
        }
      }
      if (contestedClaims.length > 0) {
        lines.push("", "### Contested Claims");
        for (const claim of contestedClaims) {
          lines.push(`- ${formatClaimHealthLine(config, claim)}`);
        }
      }
      if (staleClaims.length > 0) {
        lines.push("", "### Stale Claims");
        for (const claim of staleClaims) {
          lines.push(`- ${formatClaimHealthLine(config, claim)}`);
        }
      }
      return lines.join("\n");
    },
  },
  {
    id: "report.stale-pages",
    title: "Stale Pages",
    relativePath: "reports/stale-pages.md",
    buildBody: ({ config, pages, now }) => {
      const matches = pages
        .filter((page) => page.kind !== "report")
        .flatMap((page) => {
          const freshness = assessPageFreshness(page, now);
          if (freshness.level === "fresh") {
            return [];
          }
          return [{ page, freshness }];
        })
        .toSorted((left, right) => left.page.title.localeCompare(right.page.title));
      if (matches.length === 0) {
        return `- No aging or stale pages older than ${WIKI_AGING_DAYS} days.`;
      }
      return [
        `- Stale pages: ${matches.length}`,
        "",
        ...matches.map(
          ({ page, freshness }) =>
            `- ${formatPageLink(config, page)}: ${formatFreshnessLabel(freshness)}`,
        ),
      ].join("\n");
    },
  },
  {
    id: "report.person-agent-directory",
    title: "Person Agent Directory",
    relativePath: "reports/person-agent-directory.md",
    buildBody: ({ config, pages, now }) => {
      const matches = pages
        .filter((page) => page.kind !== "report" && isPersonLikePage(page))
        .toSorted((left, right) => left.title.localeCompare(right.title));
      if (matches.length === 0) {
        return "- No person-like entity pages with agent cards yet.";
      }
      const lines = [`- People with routing metadata: ${matches.length}`];
      for (const page of matches) {
        const freshness = assessPageFreshness(page, now);
        lines.push(`- ${formatPersonDirectoryLine(config, page, freshness)}`);
      }
      return lines.join("\n");
    },
  },
  {
    id: "report.relationship-graph",
    title: "Relationship Graph",
    relativePath: "reports/relationship-graph.md",
    buildBody: ({ config, pages }) => {
      const relationships = pages
        .flatMap((page) => page.relationships.map((relationship) => ({ page, relationship })))
        .toSorted((left, right) => {
          const leftTitle = left.relationship.targetTitle ?? left.relationship.targetId ?? "";
          const rightTitle = right.relationship.targetTitle ?? right.relationship.targetId ?? "";
          return `${left.page.title} ${leftTitle}`.localeCompare(
            `${right.page.title} ${rightTitle}`,
          );
        });
      if (relationships.length === 0) {
        return "- No structured relationships yet.";
      }
      return [
        `- Structured relationships: ${relationships.length}`,
        "",
        ...relationships.map(
          ({ page, relationship }) => `- ${formatRelationshipLine(config, page, relationship)}`,
        ),
      ].join("\n");
    },
  },
  {
    id: "report.provenance-coverage",
    title: "Provenance Coverage",
    relativePath: "reports/provenance-coverage.md",
    buildBody: ({ config, pages }) => {
      const evidenceEntries = pages.flatMap((page) =>
        page.claims.flatMap((claim) =>
          claim.evidence.map((evidence) => ({ page, claim, evidence })),
        ),
      );
      const missingEvidence = pages.flatMap((page) =>
        page.claims
          .filter((claim) => claim.evidence.length === 0)
          .map((claim) => ({ page, claim })),
      );
      if (evidenceEntries.length === 0 && missingEvidence.length === 0) {
        return "- No structured claims with provenance coverage yet.";
      }
      const kindCounts = countBy(
        evidenceEntries.map(({ evidence }) => evidence.kind ?? "unspecified"),
      );
      const sourceCounts = countBy(
        evidenceEntries.map(({ evidence }) => evidence.sourceId ?? evidence.path ?? "inline"),
      );
      const lines = [
        `- Evidence entries: ${evidenceEntries.length}`,
        `- Claims missing evidence: ${missingEvidence.length}`,
        "",
        "### Evidence Classes",
        ...formatCountLines(kindCounts),
        "",
        "### Top Evidence Sources",
        ...formatCountLines(sourceCounts).slice(0, 20),
      ];
      if (missingEvidence.length > 0) {
        lines.push("", "### Missing Evidence");
        for (const { page, claim } of missingEvidence) {
          lines.push(`- ${formatPageLink(config, page)}: ${formatClaimIdentityForPage(claim)}`);
        }
      }
      return lines.join("\n");
    },
  },
  {
    id: "report.privacy-review",
    title: "Privacy Review",
    relativePath: "reports/privacy-review.md",
    buildBody: ({ config, pages }) => {
      const entries = collectPrivacyReviewEntries(config, pages);
      if (entries.length === 0) {
        return "- No non-public privacy tiers flagged right now.";
      }
      return [`- Privacy review entries: ${entries.length}`, "", ...entries].join("\n");
    },
  },
];

export type CompileMemoryWikiResult = {
  vaultRoot: string;
  pageCounts: Record<WikiPageKind, number>;
  pages: WikiPageSummary[];
  claimCount: number;
  updatedFiles: string[];
};

export type RefreshMemoryWikiIndexesResult = {
  refreshed: boolean;
  reason: "auto-compile-disabled" | "no-import-changes" | "missing-indexes" | "import-changed";
  compile?: CompileMemoryWikiResult;
};

async function collectMarkdownFiles(rootDir: string, relativeDir: string): Promise<string[]> {
  const dirPath = path.join(rootDir, relativeDir);
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(relativeDir, entry.name))
    .filter((relativePath) => path.basename(relativePath) !== "index.md")
    .toSorted((left, right) => left.localeCompare(right));
}

async function readPageSummaries(rootDir: string): Promise<WikiPageSummary[]> {
  const filePaths = (
    await Promise.all(COMPILE_PAGE_GROUPS.map((group) => collectMarkdownFiles(rootDir, group.dir)))
  ).flat();

  const pages = await Promise.all(
    filePaths.map(async (relativePath) => {
      const absolutePath = path.join(rootDir, relativePath);
      const raw = await fs.readFile(absolutePath, "utf8");
      return toWikiPageSummary({ absolutePath, relativePath, raw });
    }),
  );

  return pages
    .flatMap((page) => (page ? [page] : []))
    .toSorted((left, right) => left.title.localeCompare(right.title));
}

function buildPageCounts(pages: WikiPageSummary[]): Record<WikiPageKind, number> {
  return {
    entity: pages.filter((page) => page.kind === "entity").length,
    concept: pages.filter((page) => page.kind === "concept").length,
    source: pages.filter((page) => page.kind === "source").length,
    synthesis: pages.filter((page) => page.kind === "synthesis").length,
    report: pages.filter((page) => page.kind === "report").length,
  };
}

function formatPageLink(config: ResolvedMemoryWikiConfig, page: WikiPageSummary): string {
  return formatWikiLink({
    renderMode: config.vault.renderMode,
    relativePath: page.relativePath,
    title: page.title,
  });
}

function formatFreshnessLabel(freshness: WikiFreshness): string {
  switch (freshness.level) {
    case "fresh":
      return `fresh (${freshness.lastTouchedAt ?? "recent"})`;
    case "aging":
      return `aging (${freshness.lastTouchedAt ?? "unknown"})`;
    case "stale":
      return `stale (${freshness.lastTouchedAt ?? "unknown"})`;
    case "unknown":
      return freshness.reason;
  }
  throw new Error("Unsupported wiki freshness level");
}

function formatListPreview(values: readonly string[], maxItems = 3): string | null {
  if (values.length === 0) {
    return null;
  }
  const shown = values.slice(0, maxItems).join(", ");
  return values.length > maxItems ? `${shown}, +${values.length - maxItems}` : shown;
}

function formatMaybeDetail(label: string, value: string | null | undefined): string | null {
  return value ? `${label} ${value}` : null;
}

function isPersonLikePage(page: WikiPageSummary): boolean {
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

function formatPersonDirectoryLine(
  config: ResolvedMemoryWikiConfig,
  page: WikiPageSummary,
  freshness: WikiFreshness,
): string {
  const card = page.personCard;
  const details = [
    formatMaybeDetail("id", page.canonicalId ?? card?.canonicalId ?? page.id),
    formatMaybeDetail("aliases", formatListPreview(page.aliases)),
    formatMaybeDetail("handles", formatListPreview(card?.handles ?? [])),
    formatMaybeDetail("lane", card?.lane),
    formatMaybeDetail("ask", formatListPreview(card?.askFor ?? [])),
    formatMaybeDetail(
      "best",
      formatListPreview([...page.bestUsedFor, ...(card?.bestUsedFor ?? [])]),
    ),
    formatMaybeDetail("privacy", page.privacyTier ?? card?.privacyTier),
    formatMaybeDetail("refreshed", page.lastRefreshedAt ?? card?.lastRefreshedAt),
    formatMaybeDetail("freshness", formatFreshnessLabel(freshness)),
  ].filter(Boolean);
  return `${formatPageLink(config, page)}${details.length > 0 ? `: ${details.join("; ")}` : ""}`;
}

function formatRelationshipTarget(
  config: ResolvedMemoryWikiConfig,
  relationship: WikiRelationship,
) {
  if (relationship.targetPath && relationship.targetTitle) {
    return formatWikiLink({
      renderMode: config.vault.renderMode,
      relativePath: relationship.targetPath,
      title: relationship.targetTitle,
    });
  }
  return relationship.targetTitle ?? relationship.targetId ?? relationship.targetPath ?? "unknown";
}

function formatRelationshipLine(
  config: ResolvedMemoryWikiConfig,
  page: WikiPageSummary,
  relationship: WikiRelationship,
): string {
  const details = [
    relationship.kind ?? "related",
    typeof relationship.weight === "number" ? `weight ${relationship.weight.toFixed(2)}` : null,
    typeof relationship.confidence === "number"
      ? `confidence ${relationship.confidence.toFixed(2)}`
      : null,
    relationship.evidenceKind ? `evidence ${relationship.evidenceKind}` : null,
    relationship.privacyTier ? `privacy ${relationship.privacyTier}` : null,
    relationship.note,
  ].filter(Boolean);
  return `${formatPageLink(config, page)} -> ${formatRelationshipTarget(config, relationship)}${
    details.length > 0 ? ` (${details.join(", ")})` : ""
  }`;
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function formatCountLines(counts: Map<string, number>): string[] {
  const lines = [...counts]
    .toSorted((left, right) => {
      if (left[1] !== right[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
    .map(([label, count]) => `- ${label}: ${count}`);
  return lines.length > 0 ? lines : ["- None"];
}

function formatClaimIdentityForPage(claim: Pick<WikiClaim, "id" | "text">): string {
  return claim.id ? `\`${claim.id}\`: ${claim.text}` : claim.text;
}

function isReviewablePrivacyTier(value: string | undefined): boolean {
  const tier = normalizeLowercaseStringOrEmpty(value);
  return tier !== "" && tier !== "public";
}

function formatEvidencePrivacyDetails(evidence: WikiClaimEvidence): string {
  return [
    evidence.kind ? `kind ${evidence.kind}` : null,
    evidence.sourceId ? `source ${evidence.sourceId}` : null,
    evidence.path ? `path ${evidence.path}` : null,
    evidence.lines ? `lines ${evidence.lines}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function collectPrivacyReviewEntries(
  config: ResolvedMemoryWikiConfig,
  pages: WikiPageSummary[],
): string[] {
  const entries: string[] = [];
  for (const page of pages) {
    if (isReviewablePrivacyTier(page.privacyTier)) {
      entries.push(`- ${formatPageLink(config, page)}: page privacy ${page.privacyTier}`);
    }
    if (isReviewablePrivacyTier(page.personCard?.privacyTier)) {
      entries.push(
        `- ${formatPageLink(config, page)}: person card privacy ${page.personCard?.privacyTier}`,
      );
    }
    for (const relationship of page.relationships) {
      if (isReviewablePrivacyTier(relationship.privacyTier)) {
        entries.push(
          `- ${formatPageLink(config, page)}: relationship privacy ${
            relationship.privacyTier
          } -> ${formatRelationshipTarget(config, relationship)}`,
        );
      }
    }
    for (const claim of page.claims) {
      for (const evidence of claim.evidence) {
        if (!isReviewablePrivacyTier(evidence.privacyTier)) {
          continue;
        }
        const detail = formatEvidencePrivacyDetails(evidence);
        entries.push(
          `- ${formatPageLink(config, page)}: evidence privacy ${evidence.privacyTier} on ${formatClaimIdentityForPage(claim)}${detail ? ` (${detail})` : ""}`,
        );
      }
    }
  }
  return entries;
}

function formatClaimIdentity(claim: WikiClaimHealth): string {
  return claim.claimId ? `\`${claim.claimId}\`: ${claim.text}` : claim.text;
}

function isClaimHealthContested(claim: WikiClaimHealth): boolean {
  return isClaimContestedStatus(claim.status);
}

function formatClaimHealthLine(config: ResolvedMemoryWikiConfig, claim: WikiClaimHealth): string {
  const details = [
    `status ${claim.status}`,
    typeof claim.confidence === "number" ? `confidence ${claim.confidence.toFixed(2)}` : null,
    claim.missingEvidence ? "missing evidence" : `${claim.evidenceCount} evidence`,
    formatFreshnessLabel(claim.freshness),
  ].filter(Boolean);
  return `${formatWikiLink({
    renderMode: config.vault.renderMode,
    relativePath: claim.pagePath,
    title: claim.pageTitle,
  })}: ${formatClaimIdentity(claim)} (${details.join(", ")})`;
}

function formatPageContradictionClusterLine(
  config: ResolvedMemoryWikiConfig,
  cluster: WikiPageContradictionCluster,
): string {
  const pageRefs = cluster.entries.map((entry) =>
    formatWikiLink({
      renderMode: config.vault.renderMode,
      relativePath: entry.pagePath,
      title: entry.pageTitle,
    }),
  );
  return `- ${cluster.label}: ${pageRefs.join(" | ")}`;
}

function formatClaimContradictionClusterLine(
  config: ResolvedMemoryWikiConfig,
  cluster: WikiClaimContradictionCluster,
): string {
  const entries = cluster.entries.map(
    (entry) =>
      `${formatWikiLink({
        renderMode: config.vault.renderMode,
        relativePath: entry.pagePath,
        title: entry.pageTitle,
      })} -> ${formatClaimIdentity(entry)} (${entry.status}, ${formatFreshnessLabel(entry.freshness)})`,
  );
  return `- \`${cluster.label}\`: ${entries.join(" | ")}`;
}

function normalizeComparableTarget(value: string): string {
  return normalizeLowercaseStringOrEmpty(
    value
      .trim()
      .replace(/\\/g, "/")
      .replace(/\.md$/i, "")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, ""),
  );
}

function uniquePages(pages: WikiPageSummary[]): WikiPageSummary[] {
  const seen = new Set<string>();
  const unique: WikiPageSummary[] = [];
  for (const page of pages) {
    const key = page.id ?? page.relativePath;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(page);
  }
  return unique;
}

function buildPageLookupKeys(page: WikiPageSummary): Set<string> {
  const keys = new Set<string>();
  keys.add(normalizeComparableTarget(page.relativePath));
  keys.add(normalizeComparableTarget(page.relativePath.replace(/\.md$/i, "")));
  keys.add(normalizeComparableTarget(page.title));
  if (page.id) {
    keys.add(normalizeComparableTarget(page.id));
  }
  return keys;
}

function renderWikiPageLinks(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
}): string {
  return params.pages
    .map(
      (page) =>
        `- ${formatWikiLink({
          renderMode: params.config.vault.renderMode,
          relativePath: page.relativePath,
          title: page.title,
        })}`,
    )
    .join("\n");
}

function sharedSourceFanout(
  page: WikiPageSummary,
  allPages: WikiPageSummary[],
): Map<string, number> {
  const sourceIds = new Set(page.sourceIds);
  const counts = new Map<string, number>();
  for (const candidate of allPages) {
    if (candidate.relativePath === page.relativePath) {
      continue;
    }
    for (const sourceId of candidate.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        continue;
      }
      counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
    }
  }
  return counts;
}

function buildRelatedBlockBody(params: {
  config: ResolvedMemoryWikiConfig;
  page: WikiPageSummary;
  allPages: WikiPageSummary[];
}): string {
  const candidatePages = params.allPages.filter((candidate) => candidate.kind !== "report");
  const sourceFanout = sharedSourceFanout(params.page, candidatePages);
  const pagesById = new Map(
    candidatePages.flatMap((candidate) =>
      candidate.id ? [[candidate.id, candidate] as const] : [],
    ),
  );
  const sourcePages = uniquePages(
    params.page.sourceIds.flatMap((sourceId) => {
      const page = pagesById.get(sourceId);
      return page ? [page] : [];
    }),
  );
  const backlinkKeys = buildPageLookupKeys(params.page);
  const backlinks = uniquePages(
    candidatePages.filter((candidate) => {
      if (candidate.relativePath === params.page.relativePath) {
        return false;
      }
      if (candidate.sourceIds.includes(params.page.id ?? "")) {
        return true;
      }
      return candidate.linkTargets.some((target) =>
        backlinkKeys.has(normalizeComparableTarget(target)),
      );
    }),
  );
  const backlinkPages =
    backlinks.length <= MAX_SHARED_SOURCE_FANOUT
      ? backlinks.slice(0, MAX_RELATED_PAGES_PER_SECTION)
      : [];
  const relatedPages = uniquePages(
    candidatePages.filter((candidate) => {
      if (candidate.relativePath === params.page.relativePath) {
        return false;
      }
      if (sourcePages.some((sourcePage) => sourcePage.relativePath === candidate.relativePath)) {
        return false;
      }
      if (backlinkPages.some((backlink) => backlink.relativePath === candidate.relativePath)) {
        return false;
      }
      if (params.page.sourceIds.length === 0 || candidate.sourceIds.length === 0) {
        return false;
      }
      return params.page.sourceIds.some(
        (sourceId) =>
          candidate.sourceIds.includes(sourceId) &&
          (sourceFanout.get(sourceId) ?? 0) <= MAX_SHARED_SOURCE_FANOUT,
      );
    }),
  ).slice(0, MAX_RELATED_PAGES_PER_SECTION);

  const sections: string[] = [];
  if (sourcePages.length > 0) {
    sections.push(
      "### Sources",
      renderWikiPageLinks({ config: params.config, pages: sourcePages }),
    );
  }
  if (backlinkPages.length > 0) {
    sections.push(
      "### Referenced By",
      renderWikiPageLinks({ config: params.config, pages: backlinkPages }),
    );
  }
  if (relatedPages.length > 0) {
    sections.push(
      "### Related Pages",
      renderWikiPageLinks({ config: params.config, pages: relatedPages }),
    );
  }
  if (sections.length === 0) {
    return "- No related pages yet.";
  }
  return sections.join("\n\n");
}

async function refreshPageRelatedBlocks(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
}): Promise<string[]> {
  if (!params.config.render.createBacklinks) {
    return [];
  }
  const root = await fsRoot(params.config.vault.path);
  const updatedFiles: string[] = [];
  for (const page of params.pages) {
    if (page.kind === "report") {
      continue;
    }
    const original = await root.readText(page.relativePath);
    if (original.trim().length === 0) {
      continue;
    }
    const updated = withTrailingNewline(
      replaceManagedMarkdownBlock({
        original,
        heading: "## Related",
        startMarker: WIKI_RELATED_START_MARKER,
        endMarker: WIKI_RELATED_END_MARKER,
        body: buildRelatedBlockBody({
          config: params.config,
          page,
          allPages: params.pages,
        }),
      }),
    );
    if (updated === original) {
      continue;
    }
    await root.write(page.relativePath, updated);
    updatedFiles.push(page.absolutePath);
  }
  return updatedFiles;
}

function renderSectionList(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
  emptyText: string;
}): string {
  if (params.pages.length === 0) {
    return `- ${params.emptyText}`;
  }
  return params.pages
    .map(
      (page) =>
        `- ${formatWikiLink({
          renderMode: params.config.vault.renderMode,
          relativePath: page.relativePath,
          title: page.title,
        })}`,
    )
    .join("\n");
}

async function writeManagedMarkdownFile(params: {
  rootDir: string;
  relativePath: string;
  title: string;
  startMarker: string;
  endMarker: string;
  body: string;
}): Promise<boolean> {
  const root = await fsRoot(params.rootDir);
  const original = await root.readText(params.relativePath).catch(() => `# ${params.title}\n`);
  const updated = replaceManagedMarkdownBlock({
    original,
    heading: "## Generated",
    startMarker: params.startMarker,
    endMarker: params.endMarker,
    body: params.body,
  });
  const rendered = withTrailingNewline(updated);
  if (rendered === original) {
    return false;
  }
  await root.write(params.relativePath, rendered);
  return true;
}

async function writeDashboardPage(params: {
  config: ResolvedMemoryWikiConfig;
  rootDir: string;
  definition: DashboardPageDefinition;
  pages: WikiPageSummary[];
  now: Date;
}): Promise<boolean> {
  const root = await fsRoot(params.rootDir);
  const original = await root.readText(params.definition.relativePath).catch(() =>
    renderWikiMarkdown({
      frontmatter: {
        pageType: "report",
        id: params.definition.id,
        title: params.definition.title,
        status: "active",
      },
      body: `# ${params.definition.title}\n`,
    }),
  );
  const parsed = parseWikiMarkdown(original);
  const originalBody =
    parsed.body.trim().length > 0 ? parsed.body : `# ${params.definition.title}\n`;
  const updatedBody = replaceManagedMarkdownBlock({
    original: originalBody,
    heading: "## Generated",
    startMarker: `<!-- openclaw:wiki:${path.basename(params.definition.relativePath, ".md")}:start -->`,
    endMarker: `<!-- openclaw:wiki:${path.basename(params.definition.relativePath, ".md")}:end -->`,
    body: params.definition.buildBody({
      config: params.config,
      pages: params.pages,
      now: params.now,
    }),
  });
  const preservedUpdatedAt =
    typeof parsed.frontmatter.updatedAt === "string" && parsed.frontmatter.updatedAt.trim()
      ? parsed.frontmatter.updatedAt
      : params.now.toISOString();
  const stableRendered = withTrailingNewline(
    renderWikiMarkdown({
      frontmatter: {
        ...parsed.frontmatter,
        pageType: "report",
        id: params.definition.id,
        title: params.definition.title,
        status:
          typeof parsed.frontmatter.status === "string" && parsed.frontmatter.status.trim()
            ? parsed.frontmatter.status
            : "active",
        updatedAt: preservedUpdatedAt,
      },
      body: updatedBody,
    }),
  );
  if (stableRendered === original) {
    return false;
  }
  const rendered = withTrailingNewline(
    renderWikiMarkdown({
      frontmatter: {
        ...parsed.frontmatter,
        pageType: "report",
        id: params.definition.id,
        title: params.definition.title,
        status:
          typeof parsed.frontmatter.status === "string" && parsed.frontmatter.status.trim()
            ? parsed.frontmatter.status
            : "active",
        updatedAt: params.now.toISOString(),
      },
      body: updatedBody,
    }),
  );
  await root.write(params.definition.relativePath, rendered);
  return true;
}

async function refreshDashboardPages(params: {
  config: ResolvedMemoryWikiConfig;
  rootDir: string;
  pages: WikiPageSummary[];
}): Promise<string[]> {
  if (!params.config.render.createDashboards) {
    return [];
  }
  const now = new Date();
  const updatedFiles: string[] = [];
  for (const definition of DASHBOARD_PAGES) {
    if (
      await writeDashboardPage({
        config: params.config,
        rootDir: params.rootDir,
        definition,
        pages: params.pages,
        now,
      })
    ) {
      updatedFiles.push(path.join(params.rootDir, definition.relativePath));
    }
  }
  return updatedFiles;
}

function buildRootIndexBody(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
  counts: Record<WikiPageKind, number>;
}): string {
  const claimCount = params.pages.reduce((total, page) => total + page.claims.length, 0);
  const lines = [
    `- Render mode: \`${params.config.vault.renderMode}\``,
    `- Total pages: ${params.pages.length}`,
    `- Claims: ${claimCount}`,
    `- Sources: ${params.counts.source}`,
    `- Entities: ${params.counts.entity}`,
    `- Concepts: ${params.counts.concept}`,
    `- Syntheses: ${params.counts.synthesis}`,
    `- Reports: ${params.counts.report}`,
  ];

  for (const group of COMPILE_PAGE_GROUPS) {
    lines.push("", `### ${group.heading}`);
    lines.push(
      renderSectionList({
        config: params.config,
        pages: params.pages.filter((page) => page.kind === group.kind),
        emptyText: `No ${normalizeLowercaseStringOrEmpty(group.heading)} yet.`,
      }),
    );
  }

  return lines.join("\n");
}

function buildDirectoryIndexBody(params: {
  config: ResolvedMemoryWikiConfig;
  pages: WikiPageSummary[];
  group: { kind: WikiPageKind; dir: string; heading: string };
}): string {
  return renderSectionList({
    config: params.config,
    pages: params.pages.filter((page) => page.kind === params.group.kind),
    emptyText: `No ${normalizeLowercaseStringOrEmpty(params.group.heading)} yet.`,
  });
}

type AgentDigestClaim = {
  id?: string;
  text: string;
  status: string;
  confidence?: number;
  evidenceCount: number;
  missingEvidence: boolean;
  evidence: WikiClaim["evidence"];
  freshnessLevel: WikiFreshnessLevel;
  lastTouchedAt?: string;
};

type AgentDigestPage = {
  id?: string;
  title: string;
  kind: WikiPageKind;
  path: string;
  pageType?: string;
  entityType?: string;
  canonicalId?: string;
  aliases: string[];
  sourceIds: string[];
  questions: string[];
  contradictions: string[];
  confidence?: number;
  privacyTier?: string;
  personCard?: WikiPageSummary["personCard"];
  bestUsedFor: string[];
  notEnoughFor: string[];
  relationshipCount: number;
  topRelationships: WikiRelationship[];
  freshnessLevel: WikiFreshnessLevel;
  lastTouchedAt?: string;
  lastRefreshedAt?: string;
  claimCount: number;
  topClaims: AgentDigestClaim[];
};

type AgentDigestClaimHealthSummary = {
  freshness: Record<WikiFreshnessLevel, number>;
  contested: number;
  lowConfidence: number;
  missingEvidence: number;
};

type AgentDigestContradictionCluster = {
  key: string;
  label: string;
  kind: "claim-id" | "page-note";
  entryCount: number;
  paths: string[];
};

type AgentDigest = {
  pageCounts: Record<WikiPageKind, number>;
  claimCount: number;
  claimHealth: AgentDigestClaimHealthSummary;
  contradictionClusters: AgentDigestContradictionCluster[];
  pages: AgentDigestPage[];
};

function createFreshnessSummary(): Record<WikiFreshnessLevel, number> {
  return {
    fresh: 0,
    aging: 0,
    stale: 0,
    unknown: 0,
  };
}

function rankFreshnessLevel(level: WikiFreshnessLevel): number {
  switch (level) {
    case "fresh":
      return 3;
    case "aging":
      return 2;
    case "stale":
      return 1;
    case "unknown":
      return 0;
  }
  throw new Error("Unsupported wiki freshness level");
}

function sortClaims(page: WikiPageSummary): WikiClaim[] {
  return [...page.claims].toSorted((left, right) => {
    const leftConfidence = left.confidence ?? -1;
    const rightConfidence = right.confidence ?? -1;
    if (leftConfidence !== rightConfidence) {
      return rightConfidence - leftConfidence;
    }
    const leftFreshness = rankFreshnessLevel(assessClaimFreshness({ page, claim: left }).level);
    const rightFreshness = rankFreshnessLevel(assessClaimFreshness({ page, claim: right }).level);
    if (leftFreshness !== rightFreshness) {
      return rightFreshness - leftFreshness;
    }
    return left.text.localeCompare(right.text);
  });
}

function buildAgentDigestClaimHealthSummary(
  pages: WikiPageSummary[],
): AgentDigestClaimHealthSummary {
  const freshness = createFreshnessSummary();
  let contested = 0;
  let lowConfidence = 0;
  let missingEvidence = 0;

  for (const claim of collectWikiClaimHealth(pages)) {
    freshness[claim.freshness.level] += 1;
    if (isClaimHealthContested(claim)) {
      contested += 1;
    }
    if (typeof claim.confidence === "number" && claim.confidence < 0.5) {
      lowConfidence += 1;
    }
    if (claim.missingEvidence) {
      missingEvidence += 1;
    }
  }

  return {
    freshness,
    contested,
    lowConfidence,
    missingEvidence,
  };
}

function buildAgentDigestContradictionClusters(
  pages: WikiPageSummary[],
): AgentDigestContradictionCluster[] {
  const pageClusters = buildPageContradictionClusters(pages).map((cluster) => ({
    key: cluster.key,
    label: cluster.label,
    kind: "page-note" as const,
    entryCount: cluster.entries.length,
    paths: [...new Set(cluster.entries.map((entry) => entry.pagePath))].toSorted(),
  }));
  const claimClusters = buildClaimContradictionClusters({ pages }).map((cluster) => ({
    key: cluster.key,
    label: cluster.label,
    kind: "claim-id" as const,
    entryCount: cluster.entries.length,
    paths: [...new Set(cluster.entries.map((entry) => entry.pagePath))].toSorted(),
  }));
  return [...pageClusters, ...claimClusters].toSorted((left, right) =>
    left.label.localeCompare(right.label),
  );
}

function buildAgentDigest(params: {
  pages: WikiPageSummary[];
  pageCounts: Record<WikiPageKind, number>;
}): AgentDigest {
  const pages = [...params.pages]
    .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((page) => {
      const pageFreshness = assessPageFreshness(page);
      return Object.assign(
        {},
        page.id ? { id: page.id } : {},
        {
          title: page.title,
          kind: page.kind,
          path: page.relativePath,
          aliases: [...page.aliases],
          sourceIds: [...page.sourceIds],
          questions: [...page.questions],
          contradictions: [...page.contradictions],
          bestUsedFor: [...page.bestUsedFor],
          notEnoughFor: [...page.notEnoughFor],
          relationshipCount: page.relationships.length,
          topRelationships: page.relationships.slice(0, 5),
        },
        page.pageType ? { pageType: page.pageType } : {},
        page.entityType ? { entityType: page.entityType } : {},
        page.canonicalId ? { canonicalId: page.canonicalId } : {},
        typeof page.confidence === "number" ? { confidence: page.confidence } : {},
        page.privacyTier ? { privacyTier: page.privacyTier } : {},
        page.personCard ? { personCard: page.personCard } : {},
        { freshnessLevel: pageFreshness.level },
        pageFreshness.lastTouchedAt ? { lastTouchedAt: pageFreshness.lastTouchedAt } : {},
        page.lastRefreshedAt ? { lastRefreshedAt: page.lastRefreshedAt } : {},
        {
          claimCount: page.claims.length,
          topClaims: sortClaims(page)
            .slice(0, 5)
            .map((claim) => {
              const freshness = assessClaimFreshness({ page, claim });
              return Object.assign(
                {},
                claim.id ? { id: claim.id } : {},
                {
                  text: claim.text,
                  status: normalizeClaimStatus(claim.status),
                },
                typeof claim.confidence === "number" ? { confidence: claim.confidence } : {},
                {
                  evidenceCount: claim.evidence.length,
                  missingEvidence: claim.evidence.length === 0,
                  evidence: [...claim.evidence],
                  freshnessLevel: freshness.level,
                },
                freshness.lastTouchedAt ? { lastTouchedAt: freshness.lastTouchedAt } : {},
              );
            }),
        },
      );
    });
  return {
    pageCounts: params.pageCounts,
    claimCount: params.pages.reduce((total, page) => total + page.claims.length, 0),
    claimHealth: buildAgentDigestClaimHealthSummary(params.pages),
    contradictionClusters: buildAgentDigestContradictionClusters(params.pages),
    pages,
  };
}

function buildClaimsDigestLines(params: { pages: WikiPageSummary[] }): string[] {
  return params.pages
    .flatMap((page) =>
      sortClaims(page).map((claim) => {
        const freshness = assessClaimFreshness({ page, claim });
        return JSON.stringify({
          ...(claim.id ? { id: claim.id } : {}),
          pageId: page.id,
          pageTitle: page.title,
          pageKind: page.kind,
          pagePath: page.relativePath,
          pageType: page.pageType,
          entityType: page.entityType,
          canonicalId: page.canonicalId,
          aliases: page.aliases,
          text: claim.text,
          status: normalizeClaimStatus(claim.status),
          confidence: claim.confidence,
          sourceIds: page.sourceIds,
          evidenceKinds: [...new Set(claim.evidence.flatMap((entry) => entry.kind ?? []))],
          privacyTiers: [
            ...new Set(
              [
                page.privacyTier,
                page.personCard?.privacyTier,
                ...claim.evidence.map((entry) => entry.privacyTier),
              ].flatMap((entry) => entry ?? []),
            ),
          ],
          evidenceCount: claim.evidence.length,
          missingEvidence: claim.evidence.length === 0,
          evidence: claim.evidence,
          freshnessLevel: freshness.level,
          lastTouchedAt: freshness.lastTouchedAt,
        });
      }),
    )
    .toSorted((left, right) => left.localeCompare(right));
}

async function writeAgentDigestArtifacts(params: {
  rootDir: string;
  pages: WikiPageSummary[];
  pageCounts: Record<WikiPageKind, number>;
}): Promise<string[]> {
  const updatedFiles: string[] = [];
  const agentDigestPath = path.join(params.rootDir, AGENT_DIGEST_PATH);
  const claimsDigestPath = path.join(params.rootDir, CLAIMS_DIGEST_PATH);
  const agentDigest = `${JSON.stringify(
    buildAgentDigest({
      pages: params.pages,
      pageCounts: params.pageCounts,
    }),
    null,
    2,
  )}\n`;
  const claimsDigest = withTrailingNewline(
    buildClaimsDigestLines({ pages: params.pages }).join("\n"),
  );

  for (const [filePath, content] of [
    [agentDigestPath, agentDigest],
    [claimsDigestPath, claimsDigest],
  ] as const) {
    const relativePath = path.relative(params.rootDir, filePath);
    const root = await fsRoot(params.rootDir);
    const existing = await root.readText(relativePath).catch(() => "");
    if (existing === content) {
      continue;
    }
    await root.write(relativePath, content);
    updatedFiles.push(filePath);
  }
  return updatedFiles;
}

export async function compileMemoryWikiVault(
  config: ResolvedMemoryWikiConfig,
): Promise<CompileMemoryWikiResult> {
  await initializeMemoryWikiVault(config);
  const rootDir = config.vault.path;
  let pages = await readPageSummaries(rootDir);
  const updatedFiles = await refreshPageRelatedBlocks({ config, pages });
  if (updatedFiles.length > 0) {
    pages = await readPageSummaries(rootDir);
  }
  const dashboardUpdatedFiles = await refreshDashboardPages({ config, rootDir, pages });
  updatedFiles.push(...dashboardUpdatedFiles);
  if (dashboardUpdatedFiles.length > 0) {
    pages = await readPageSummaries(rootDir);
  }
  const counts = buildPageCounts(pages);
  const digestUpdatedFiles = await writeAgentDigestArtifacts({
    rootDir,
    pages,
    pageCounts: counts,
  });
  updatedFiles.push(...digestUpdatedFiles);

  const rootIndexPath = path.join(rootDir, "index.md");
  if (
    await writeManagedMarkdownFile({
      rootDir,
      relativePath: "index.md",
      title: "Wiki Index",
      startMarker: "<!-- openclaw:wiki:index:start -->",
      endMarker: "<!-- openclaw:wiki:index:end -->",
      body: buildRootIndexBody({ config, pages, counts }),
    })
  ) {
    updatedFiles.push(rootIndexPath);
  }

  for (const group of COMPILE_PAGE_GROUPS) {
    const relativePath = path.join(group.dir, "index.md").replace(/\\/g, "/");
    const filePath = path.join(rootDir, relativePath);
    if (
      await writeManagedMarkdownFile({
        rootDir,
        relativePath,
        title: group.heading,
        startMarker: `<!-- openclaw:wiki:${group.dir}:index:start -->`,
        endMarker: `<!-- openclaw:wiki:${group.dir}:index:end -->`,
        body: buildDirectoryIndexBody({ config, pages, group }),
      })
    ) {
      updatedFiles.push(filePath);
    }
  }

  if (updatedFiles.length > 0) {
    await appendMemoryWikiLog(rootDir, {
      type: "compile",
      timestamp: new Date().toISOString(),
      details: {
        pageCounts: counts,
        updatedFiles: updatedFiles.map((filePath) => path.relative(rootDir, filePath)),
      },
    });
  }

  return {
    vaultRoot: rootDir,
    pageCounts: counts,
    pages,
    claimCount: pages.reduce((total, page) => total + page.claims.length, 0),
    updatedFiles,
  };
}

async function hasMissingWikiIndexes(rootDir: string): Promise<boolean> {
  const required = [
    path.join(rootDir, "index.md"),
    ...COMPILE_PAGE_GROUPS.map((group) => path.join(rootDir, group.dir, "index.md")),
  ];
  for (const filePath of required) {
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      return true;
    }
  }
  return false;
}

export async function refreshMemoryWikiIndexesAfterImport(params: {
  config: ResolvedMemoryWikiConfig;
  syncResult: { importedCount: number; updatedCount: number; removedCount: number };
}): Promise<RefreshMemoryWikiIndexesResult> {
  await initializeMemoryWikiVault(params.config);
  if (!params.config.ingest.autoCompile) {
    return {
      refreshed: false,
      reason: "auto-compile-disabled",
    };
  }
  const importChanged =
    params.syncResult.importedCount > 0 ||
    params.syncResult.updatedCount > 0 ||
    params.syncResult.removedCount > 0;
  const missingIndexes = await hasMissingWikiIndexes(params.config.vault.path);
  if (!importChanged && !missingIndexes) {
    return {
      refreshed: false,
      reason: "no-import-changes",
    };
  }
  const compile = await compileMemoryWikiVault(params.config);
  return {
    refreshed: true,
    reason: missingIndexes && !importChanged ? "missing-indexes" : "import-changed",
    compile,
  };
}
