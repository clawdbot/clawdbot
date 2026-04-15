import fs from "node:fs/promises";
import path from "node:path";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import {
  assessPageFreshness,
  buildClaimContradictionClusters,
  collectWikiClaimHealth,
} from "./claim-health.js";
import { compileMemoryWikiVault } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import { renderWikiMarkdown, type WikiPageSummary } from "./markdown.js";

export type MemoryWikiLintIssue = {
  severity: "error" | "warning";
  category: "structure" | "provenance" | "links" | "contradictions" | "open-questions" | "quality";
  code:
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

export type LintMemoryWikiResult = {
  vaultRoot: string;
  issueCount: number;
  issues: MemoryWikiLintIssue[];
  issuesByCategory: Record<MemoryWikiLintIssue["category"], MemoryWikiLintIssue[]>;
  reportPath: string;
};

function toExpectedPageType(page: WikiPageSummary): string {
  return page.kind;
}

function collectBrokenLinkIssues(pages: WikiPageSummary[]): MemoryWikiLintIssue[] {
  const validTargets = new Set<string>();
  for (const page of pages) {
    const withoutExtension = page.relativePath.replace(/\.md$/i, "");
    validTargets.add(withoutExtension);
    validTargets.add(path.basename(withoutExtension));
  }

  const issues: MemoryWikiLintIssue[] = [];
  for (const page of pages) {
    for (const linkTarget of page.linkTargets) {
      if (!validTargets.has(linkTarget)) {
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

function collectPageIssues(pages: WikiPageSummary[]): MemoryWikiLintIssue[] {
  const issues: MemoryWikiLintIssue[] = [];
  const pagesById = new Map<string, WikiPageSummary[]>();
  const claimHealth = collectWikiClaimHealth(pages);

  for (const page of pages) {
    if (!page.id) {
      issues.push({
        severity: "error",
        category: "structure",
        code: "missing-id",
        path: page.relativePath,
        message: "Missing `id` frontmatter.",
      });
    } else {
      const current = pagesById.get(page.id) ?? [];
      current.push(page);
      pagesById.set(page.id, current);
    }

    if (!page.pageType) {
      issues.push({
        severity: "error",
        category: "structure",
        code: "missing-page-type",
        path: page.relativePath,
        message: "Missing `pageType` frontmatter.",
      });
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
    if (page.kind !== "report" && (freshness.level === "stale" || freshness.level === "unknown")) {
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
  const issues = collectPageIssues(compileResult.pages);
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
