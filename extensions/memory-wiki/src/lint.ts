// Memory Wiki plugin module implements lint behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assessPageFreshness,
  buildClaimContradictionClusters,
  collectWikiClaimHealth,
} from "./claim-health.js";
import { compileMemoryWikiVault } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  isUnmanagedRawSourceSummary,
  parseWikiMarkdown,
  renderWikiMarkdown,
  slugifyWikiSegment,
  type WikiPageSummary,
} from "./markdown.js";
import { readMemoryWikiSourceSyncState } from "./source-sync-state.js";

type MemoryWikiLintIssue = {
  severity: "error" | "warning";
  category: "structure" | "provenance" | "links" | "contradictions" | "open-questions" | "quality";
  code:
    | "invalid-frontmatter"
    | "missing-id"
    | "duplicate-id"
    | "missing-page-type"
    | "page-type-mismatch"
    | "missing-title"
    | "missing-source-ids"
    | "missing-import-provenance"
    | "broken-wikilink"
    | "contradiction-present"
    | "claim-conflict"
    | "open-question"
    | "low-confidence"
    | "claim-low-confidence"
    | "claim-missing-evidence"
    | "stale-page"
    | "stale-claim";
  path: string;
  message: string;
};

type LintMemoryWikiResult = {
  vaultRoot: string;
  issueCount: number;
  issues: MemoryWikiLintIssue[];
  issuesByCategory: Record<MemoryWikiLintIssue["category"], MemoryWikiLintIssue[]>;
  reportPath: string;
};

function toExpectedPageType(page: WikiPageSummary): string {
  return page.kind;
}

function isUnmanagedRawSourcePage(
  page: WikiPageSummary,
  managedImportedSourcePagePaths: Set<string>,
): boolean {
  return (
    isUnmanagedRawSourceSummary(page) && !managedImportedSourcePagePaths.has(page.relativePath)
  );
}

type WikiLinkTargetIndex = {
  pathTargets: Set<string>;
  aliasTargets: Set<string>;
};

function normalizeLintPathTarget(value: string): string {
  return normalizeLintTarget(value, { stripQuery: true });
}

function normalizeLintAliasTextTarget(value: string): string {
  return normalizeLintTarget(value, { stripQuery: false });
}

function normalizeLintTarget(value: string, options: { stripQuery: boolean }): string {
  const withoutFragment = value.trim().replace(/\\/g, "/").split("#")[0] ?? "";
  const target = options.stripQuery ? (withoutFragment.split("?")[0] ?? "") : withoutFragment;
  return target
    .replace(/\.md$/i, "")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim();
}

function normalizeLintAliasTarget(value: string): string {
  return normalizeLowercaseStringOrEmpty(normalizeLintAliasTextTarget(value));
}

function hasLintTargetQuery(value: string): boolean {
  const withoutFragment = value.trim().replace(/\\/g, "/").split("#")[0] ?? "";
  return withoutFragment.includes("?");
}

function isLintPathStyleTarget(value: string): boolean {
  const withoutFragment = value.trim().replace(/\\/g, "/").split("#")[0] ?? "";
  const withoutQuery = withoutFragment.split("?")[0] ?? "";
  return (
    withoutQuery.startsWith("/") ||
    withoutQuery.startsWith("./") ||
    withoutQuery.includes("/") ||
    /\.md$/i.test(withoutQuery)
  );
}

function addPathTarget(index: WikiLinkTargetIndex, raw: string | undefined) {
  const normalized = raw ? normalizeLintPathTarget(raw) : "";
  if (!normalized) {
    return;
  }
  index.pathTargets.add(normalized);
  index.pathTargets.add(path.posix.basename(normalized));
}

function addAliasTarget(index: WikiLinkTargetIndex, raw: string | undefined) {
  const normalized = raw ? normalizeLintAliasTarget(raw) : "";
  if (normalized) {
    index.aliasTargets.add(normalized);
  }
}

function addSlugAliasTarget(index: WikiLinkTargetIndex, raw: string | undefined) {
  const normalized = raw ? normalizeLintAliasTextTarget(raw) : "";
  if (normalized) {
    index.aliasTargets.add(slugifyWikiSegment(normalized));
  }
}

function addTitleTarget(index: WikiLinkTargetIndex, raw: string | undefined) {
  addAliasTarget(index, raw);
  addSlugAliasTarget(index, raw);
}

function addPathSuffixTargets(index: WikiLinkTargetIndex, raw: string | undefined) {
  const normalized = raw ? normalizeLintPathTarget(raw) : "";
  if (!normalized) {
    return;
  }
  const parts = normalized.split("/").filter(Boolean);
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const suffix = parts.slice(partIndex).join("/");
    addPathTarget(index, suffix);
    addSlugAliasTarget(index, suffix);
  }
}

function buildWikiLinkTargetIndex(pages: WikiPageSummary[]): WikiLinkTargetIndex {
  const index: WikiLinkTargetIndex = {
    pathTargets: new Set(),
    aliasTargets: new Set(),
  };
  for (const page of pages) {
    addPathTarget(index, page.relativePath);
    addTitleTarget(index, page.title);
    addPathSuffixTargets(index, page.sourcePath);
    addPathSuffixTargets(index, page.bridgeRelativePath);
    addPathSuffixTargets(index, page.unsafeLocalRelativePath);
  }
  return index;
}

function hasValidWikiLinkTarget(index: WikiLinkTargetIndex, rawTarget: string): boolean {
  const pathTarget = normalizeLintPathTarget(rawTarget);
  if (!pathTarget) {
    return true;
  }
  if (
    index.pathTargets.has(pathTarget) &&
    (!hasLintTargetQuery(rawTarget) || isLintPathStyleTarget(rawTarget))
  ) {
    return true;
  }
  if (pathTarget.includes("/")) {
    return false;
  }
  return (
    index.aliasTargets.has(normalizeLintAliasTarget(rawTarget)) ||
    index.aliasTargets.has(slugifyWikiSegment(normalizeLintAliasTextTarget(rawTarget)))
  );
}

function collectBrokenLinkIssues(pages: WikiPageSummary[]): MemoryWikiLintIssue[] {
  const validTargets = buildWikiLinkTargetIndex(pages);

  const issues: MemoryWikiLintIssue[] = [];
  for (const page of pages) {
    for (const linkTarget of page.linkTargets) {
      if (!hasValidWikiLinkTarget(validTargets, linkTarget)) {
        issues.push({
          severity: "warning",
          category: "links",
          code: "broken-wikilink",
          path: page.relativePath,
          message: `Broken wikilink target \`${linkTarget}\`.`,
        });
      }
    }
  }
  return issues;
}

function collectPageIssues(
  pages: WikiPageSummary[],
  managedImportedSourcePagePaths: Set<string>,
): MemoryWikiLintIssue[] {
  const issues: MemoryWikiLintIssue[] = [];
  const pagesById = new Map<string, WikiPageSummary[]>();
  const claimHealth = collectWikiClaimHealth(pages);

  for (const page of pages) {
    const requiresStructuredPageMetadata = !isUnmanagedRawSourcePage(
      page,
      managedImportedSourcePagePaths,
    );

    if (!page.id) {
      if (requiresStructuredPageMetadata) {
        issues.push({
          severity: "error",
          category: "structure",
          code: "missing-id",
          path: page.relativePath,
          message: "Missing `id` frontmatter.",
        });
      }
    } else {
      const current = pagesById.get(page.id) ?? [];
      current.push(page);
      pagesById.set(page.id, current);
    }

    if (!page.pageType) {
      if (requiresStructuredPageMetadata) {
        issues.push({
          severity: "error",
          category: "structure",
          code: "missing-page-type",
          path: page.relativePath,
          message: "Missing `pageType` frontmatter.",
        });
      }
    } else if (page.pageType !== toExpectedPageType(page)) {
      issues.push({
        severity: "error",
        category: "structure",
        code: "page-type-mismatch",
        path: page.relativePath,
        message: `Expected pageType \`${toExpectedPageType(page)}\`, found \`${page.pageType}\`.`,
      });
    }

    if (!page.title.trim()) {
      issues.push({
        severity: "error",
        category: "structure",
        code: "missing-title",
        path: page.relativePath,
        message: "Missing page title.",
      });
    }

    if (page.kind !== "source" && page.kind !== "report" && page.sourceIds.length === 0) {
      issues.push({
        severity: "warning",
        category: "provenance",
        code: "missing-source-ids",
        path: page.relativePath,
        message: "Non-source page is missing `sourceIds` provenance.",
      });
    }

    if (
      (page.sourceType === "memory-bridge" || page.sourceType === "memory-bridge-events") &&
      (!page.sourcePath || !page.bridgeRelativePath || !page.bridgeWorkspaceDir)
    ) {
      issues.push({
        severity: "warning",
        category: "provenance",
        code: "missing-import-provenance",
        path: page.relativePath,
        message:
          "Bridge-imported source page is missing `sourcePath`, `bridgeRelativePath`, or `bridgeWorkspaceDir` provenance.",
      });
    }

    if (
      (page.provenanceMode === "unsafe-local" || page.sourceType === "memory-unsafe-local") &&
      (!page.sourcePath || !page.unsafeLocalConfiguredPath || !page.unsafeLocalRelativePath)
    ) {
      issues.push({
        severity: "warning",
        category: "provenance",
        code: "missing-import-provenance",
        path: page.relativePath,
        message:
          "Unsafe-local source page is missing `sourcePath`, `unsafeLocalConfiguredPath`, or `unsafeLocalRelativePath` provenance.",
      });
    }

    if (page.contradictions.length > 0) {
      issues.push({
        severity: "warning",
        category: "contradictions",
        code: "contradiction-present",
        path: page.relativePath,
        message: `Page lists ${page.contradictions.length} contradiction${page.contradictions.length === 1 ? "" : "s"} to resolve.`,
      });
    }

    if (page.questions.length > 0) {
      issues.push({
        severity: "warning",
        category: "open-questions",
        code: "open-question",
        path: page.relativePath,
        message: `Page lists ${page.questions.length} open question${page.questions.length === 1 ? "" : "s"}.`,
      });
    }

    if (typeof page.confidence === "number" && page.confidence < 0.5) {
      issues.push({
        severity: "warning",
        category: "quality",
        code: "low-confidence",
        path: page.relativePath,
        message: `Page confidence is low (${page.confidence.toFixed(2)}).`,
      });
    }

    const freshness = assessPageFreshness(page);
    if (
      requiresStructuredPageMetadata &&
      page.kind !== "report" &&
      (freshness.level === "stale" || freshness.level === "unknown")
    ) {
      issues.push({
        severity: "warning",
        category: "quality",
        code: "stale-page",
        path: page.relativePath,
        message: `Page freshness needs review (${freshness.reason}).`,
      });
    }
  }

  for (const claim of claimHealth) {
    if (claim.missingEvidence) {
      issues.push({
        severity: "warning",
        category: "provenance",
        code: "claim-missing-evidence",
        path: claim.pagePath,
        message: `Claim ${claim.claimId ? `\`${claim.claimId}\`` : `\`${claim.text}\``} is missing structured evidence.`,
      });
    }
    if (typeof claim.confidence === "number" && claim.confidence < 0.5) {
      issues.push({
        severity: "warning",
        category: "quality",
        code: "claim-low-confidence",
        path: claim.pagePath,
        message: `Claim ${claim.claimId ? `\`${claim.claimId}\`` : `\`${claim.text}\``} has low confidence (${claim.confidence.toFixed(2)}).`,
      });
    }
    if (claim.freshness.level === "stale" || claim.freshness.level === "unknown") {
      issues.push({
        severity: "warning",
        category: "quality",
        code: "stale-claim",
        path: claim.pagePath,
        message: `Claim ${claim.claimId ? `\`${claim.claimId}\`` : `\`${claim.text}\``} freshness needs review (${claim.freshness.reason}).`,
      });
    }
  }

  for (const cluster of buildClaimContradictionClusters({ pages })) {
    for (const entry of cluster.entries) {
      issues.push({
        severity: "warning",
        category: "contradictions",
        code: "claim-conflict",
        path: entry.pagePath,
        message: `Claim cluster \`${cluster.label}\` has competing variants across ${cluster.entries.length} pages.`,
      });
    }
  }

  for (const [id, matches] of pagesById.entries()) {
    if (matches.length > 1) {
      for (const match of matches) {
        issues.push({
          severity: "error",
          category: "structure",
          code: "duplicate-id",
          path: match.relativePath,
          message: `Duplicate page id \`${id}\`.`,
        });
      }
    }
  }

  issues.push(...collectBrokenLinkIssues(pages));
  return issues.toSorted((left, right) => left.path.localeCompare(right.path));
}

function buildIssuesByCategory(
  issues: MemoryWikiLintIssue[],
): Record<MemoryWikiLintIssue["category"], MemoryWikiLintIssue[]> {
  return {
    structure: issues.filter((issue) => issue.category === "structure"),
    provenance: issues.filter((issue) => issue.category === "provenance"),
    links: issues.filter((issue) => issue.category === "links"),
    contradictions: issues.filter((issue) => issue.category === "contradictions"),
    "open-questions": issues.filter((issue) => issue.category === "open-questions"),
    quality: issues.filter((issue) => issue.category === "quality"),
  };
}

function buildLintReportBody(issues: MemoryWikiLintIssue[]): string {
  if (issues.length === 0) {
    return "No issues found.";
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const byCategory = buildIssuesByCategory(issues);
  const lines = [`- Errors: ${errors.length}`, `- Warnings: ${warnings.length}`];

  if (errors.length > 0) {
    lines.push("", "### Errors");
    for (const issue of errors) {
      lines.push(`- \`${issue.path}\`: ${issue.message}`);
    }
  }

  if (warnings.length > 0) {
    lines.push("", "### Warnings");
    for (const issue of warnings) {
      lines.push(`- \`${issue.path}\`: ${issue.message}`);
    }
  }

  if (byCategory.contradictions.length > 0) {
    lines.push("", "### Contradictions");
    for (const issue of byCategory.contradictions) {
      lines.push(`- \`${issue.path}\`: ${issue.message}`);
    }
  }

  if (byCategory["open-questions"].length > 0) {
    lines.push("", "### Open Questions");
    for (const issue of byCategory["open-questions"]) {
      lines.push(`- \`${issue.path}\`: ${issue.message}`);
    }
  }

  if (byCategory.provenance.length > 0 || byCategory.quality.length > 0) {
    lines.push("", "### Quality Follow-Up");
    for (const issue of [...byCategory.provenance, ...byCategory.quality]) {
      lines.push(`- \`${issue.path}\`: ${issue.message}`);
    }
  }

  return lines.join("\n");
}

async function writeLintReport(rootDir: string, issues: MemoryWikiLintIssue[]): Promise<string> {
  const reportPath = path.join(rootDir, "reports", "lint.md");
  const original = await fs.readFile(reportPath, "utf8").catch(() =>
    renderWikiMarkdown({
      frontmatter: {
        pageType: "report",
        id: "report.lint",
        title: "Lint Report",
        status: "active",
      },
      body: "# Lint Report\n",
    }),
  );
  // The lint report is itself a wiki page. Keep its metadata fail-closed before
  // replacing the managed body so malformed frontmatter is never rewritten.
  parseWikiMarkdown(original);
  const updated = replaceManagedMarkdownBlock({
    original,
    heading: "## Generated",
    startMarker: "<!-- openclaw:wiki:lint:start -->",
    endMarker: "<!-- openclaw:wiki:lint:end -->",
    body: buildLintReportBody(issues),
  });
  await fs.writeFile(reportPath, withTrailingNewline(updated), "utf8");
  return reportPath;
}

export async function lintMemoryWikiVault(
  config: ResolvedMemoryWikiConfig,
): Promise<LintMemoryWikiResult> {
  const compileResult = await compileMemoryWikiVault(config);
  const sourceSyncState = await readMemoryWikiSourceSyncState(config.vault.path);
  const managedImportedSourcePagePaths = new Set(
    Object.values(sourceSyncState.entries).map((entry) => entry.pagePath.split(path.sep).join("/")),
  );
  const issues = [
    ...compileResult.frontmatterErrors.map(
      (error): MemoryWikiLintIssue => ({
        severity: "error",
        category: "structure",
        code: "invalid-frontmatter",
        path: error.relativePath,
        message: `Frontmatter failed to parse: ${error.message}`,
      }),
    ),
    ...collectPageIssues(compileResult.pages, managedImportedSourcePagePaths),
  ].toSorted((left, right) => left.path.localeCompare(right.path));
  const issuesByCategory = buildIssuesByCategory(issues);
  const reportPath = await writeLintReport(config.vault.path, issues);

  await appendMemoryWikiLog(config.vault.path, {
    type: "lint",
    timestamp: new Date().toISOString(),
    details: {
      issueCount: issues.length,
      reportPath: path.relative(config.vault.path, reportPath),
    },
  });

  return {
    vaultRoot: config.vault.path,
    issueCount: issues.length,
    issues,
    issuesByCategory,
    reportPath,
  };
}
