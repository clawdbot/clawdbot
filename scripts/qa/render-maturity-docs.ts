#!/usr/bin/env node
// Renders public maturity scorecard docs from the root taxonomy and score aggregate.
import fs from "node:fs";
import path from "node:path";
import {
  validateQaEvidenceSummaryJson,
  type QaEvidenceStatus,
  type QaEvidenceSummaryJson,
} from "../../extensions/qa-lab/src/evidence-summary.js";
import {
  QA_MATURITY_SCORE_LABEL_BANDS,
  activeQaMaturityTaxonomySurfaces,
  qaMaturityFamilyOrder,
  qaMaturityCoverageCategoryKey,
  qaMaturityScoreObjectForScore,
  qaMaturityTaxonomyLevelMap,
  readQaMaturityTaxonomySource,
  readValidatedQaMaturityScoreSources,
  type QaMaturityCoverageScores,
  type QaMaturityScoreObject,
  type QaMaturityScoreSurface,
  type QaMaturityScoreSurfaceLts,
  type QaMaturityScores,
  type QaMaturityTaxonomy,
  type QaMaturityTaxonomyLevel,
  type QaMaturityTaxonomySurface,
} from "../../extensions/qa-lab/src/scorecard-taxonomy.js";

const DEFAULT_TAXONOMY_PATH = "taxonomy.yaml";
const DEFAULT_SCORES_PATH = "qa/maturity-scores.yaml";
const DEFAULT_STATE_PATH = "qa/maturity-docs-state.json";
const DEFAULT_DOCS_ROOT = "docs";
const DEFAULT_OUTPUT_DIR = ".artifacts/maturity-docs";

type Args = {
  taxonomy: string;
  scores: string;
  docsRoot: string;
  outputDir: string;
  outputDirExplicit: boolean;
  staticAssetsDir?: string;
  evidenceDir?: string;
  statePath: string;
  stateOutput?: string;
  check: boolean;
  strictInputs: boolean;
};

type PublicCount = {
  fulfilled: number;
  total: number;
  fulfillmentPercent: number;
};

type PublicCategoryReport = {
  surfaceId: string;
  name: string;
  status: "fulfilled" | "partial" | "missing";
  features: PublicCount;
  coverageIds: PublicCount;
  missingCoverageCount: number;
  docs: string;
};

type PublicScorecard = {
  categories: PublicCount;
  features: PublicCount;
  coverageIds: PublicCount;
  categoryReports: PublicCategoryReport[];
};

type EvidenceSummary = {
  sourcePath: string;
  path: string;
  generatedAt: string;
  profile: string;
  entryCount: number;
  statuses: StatusCounts;
  blockingResults: string[];
  scorecard?: PublicScorecard;
};

type StateCount = [fulfilled: number, total: number, fulfillmentPercent: number];

type StateCategory = [
  surfaceName: string,
  categoryName: string,
  status: PublicCategoryReport["status"],
  featureFulfilled: number,
  featureTotal: number,
  featurePercent: number,
  coverageFulfilled: number,
  coverageTotal: number,
  coveragePercent: number,
  missingCoverageCount: number,
  docs: string,
];

type MaturityDocsStateSummary = {
  categories: StateCategory[];
  entryCount: number;
  generatedAt: string;
  profile: string;
  statuses: StatusCounts;
  totals: {
    categories: StateCount;
    coverageIds: StateCount;
    features: StateCount;
  };
};

type MaturityDocsState = {
  summaries: MaturityDocsStateSummary[];
  version: 1;
};

type StatusCounts = Record<QaEvidenceStatus, number>;

const EMPTY_STATUS_COUNTS: StatusCounts = {
  pass: 0,
  fail: 0,
  blocked: 0,
  skipped: 0,
};

type RenderInputs = {
  taxonomy: QaMaturityTaxonomy;
  scores: QaMaturityScores;
  coverage: DerivedCoverageScores;
};

type DocsRouteIndex = {
  routes: Set<string>;
  redirects: Map<string, string>;
};

type RenderMaturityScorecardInputs = Pick<RenderInputs, "taxonomy" | "scores" | "coverage"> & {
  evidenceSummaries: EvidenceSummary[];
};

type DerivedCoverageScores = QaMaturityCoverageScores & {
  categoryDocs: Map<string, string>;
  categoryFeatureTotals: Map<string, number>;
  surfaces: Map<string, QaMaturityScoreObject>;
  rollups: {
    surface_average?: QaMaturityScoreObject;
    category_average?: QaMaturityScoreObject;
  };
  warnings: string[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    taxonomy: DEFAULT_TAXONOMY_PATH,
    scores: DEFAULT_SCORES_PATH,
    docsRoot: DEFAULT_DOCS_ROOT,
    outputDir: DEFAULT_OUTPUT_DIR,
    outputDirExplicit: false,
    staticAssetsDir: undefined,
    evidenceDir: undefined,
    statePath: DEFAULT_STATE_PATH,
    stateOutput: undefined,
    check: false,
    strictInputs: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--check") {
      args.check = true;
      continue;
    }
    if (arg === "--strict-inputs") {
      args.strictInputs = true;
      continue;
    }
    const next = (): string => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--taxonomy") {
      args.taxonomy = next();
    } else if (arg === "--scores") {
      args.scores = next();
    } else if (arg === "--docs-root") {
      args.docsRoot = next();
    } else if (arg === "--output-dir") {
      args.outputDir = next();
      args.outputDirExplicit = true;
    } else if (arg === "--static-assets-dir") {
      args.staticAssetsDir = next();
    } else if (arg === "--evidence-dir") {
      args.evidenceDir = next();
    } else if (arg === "--state") {
      args.statePath = next();
    } else if (arg === "--state-output") {
      args.stateOutput = next();
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`Usage: node --import tsx scripts/qa/render-maturity-docs.ts [options]

Options:
  --taxonomy <path>     Taxonomy YAML path (default: taxonomy.yaml)
  --scores <path>       Aggregate score YAML path (default: qa/maturity-scores.yaml)
  --docs-root <path>    Public docs source root for route validation (default: docs)
  --output-dir <path>   Directory for maturity/scorecard.md and maturity/taxonomy.md
  --static-assets-dir <path>
                        Copy source YAML and QA evidence JSON for docs components
  --evidence-dir <path> Optional directory containing qa-evidence.json artifacts
  --state <path>        Sanitized public evidence projection (default: qa/maturity-docs-state.json)
  --state-output <path> Atomically write a sanitized projection from --evidence-dir
  --check               Fail when output files are stale
  --strict-inputs       Fail on score or evidence input warnings
  -h, --help            Show this help
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown maturity docs option: ${arg}`);
    }
  }
  return args;
}

function familyTitle(value: string): string {
  const titles: Record<string, string> = {
    googlechat: "Google Chat",
    imessage: "iMessage",
    msteams: "Microsoft Teams",
    openai: "OpenAI",
    openclaw: "OpenClaw",
    "platform-app": "Platform",
    "provider-tool": "Provider and tool",
    whatsapp: "WhatsApp",
  };
  return (
    titles[value] ??
    value
      .replaceAll("-", " ")
      .replaceAll("_", " ")
      .replace(/\b\w/g, (char) => char.toUpperCase())
  );
}

type RenderScalar = string | number | boolean | null | undefined;

function markdownEscape(value: RenderScalar): string {
  return String(value ?? "").replaceAll("|", "\\|");
}

function markdownSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll("&", "and")
    .replace(/[/:]/g, " ")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeRoutePath(route: string): string {
  return route.replace(/^\/+/, "").replace(/\/+$/, "");
}

function collectDocsRouteIndex(docsRoot: string): DocsRouteIndex {
  const routes = new Set<string>();
  const redirects = new Map<string, string>();
  if (!fs.existsSync(docsRoot)) {
    return { routes, redirects };
  }
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "internal" && path.relative(docsRoot, fullPath) === "internal") {
          continue;
        }
        visit(fullPath);
      } else if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
        routes.add(
          path
            .relative(docsRoot, fullPath)
            .replaceAll(path.sep, "/")
            .replace(/\.(md|mdx)$/i, ""),
        );
      }
    }
  };
  visit(docsRoot);

  const docsJsonPath = path.join(docsRoot, "docs.json");
  if (fs.existsSync(docsJsonPath)) {
    const docsJson = JSON.parse(fs.readFileSync(docsJsonPath, "utf8")) as {
      redirects?: Array<{ source?: string; destination?: string }>;
    };
    for (const redirect of docsJson.redirects ?? []) {
      if (!redirect.source || !redirect.destination || redirect.destination.startsWith("http")) {
        continue;
      }
      redirects.set(normalizeRoutePath(redirect.source), normalizeRoutePath(redirect.destination));
    }
  }
  return { routes, redirects };
}

function docsLink(docPath: string, docsRouteIndex: DocsRouteIndex): string | undefined {
  const docsPrefix = "docs/";
  const trimmedPath = docPath.trim();
  const publicPath = trimmedPath.startsWith(docsPrefix)
    ? trimmedPath.slice(docsPrefix.length)
    : trimmedPath;
  const [pagePath = "", anchor] = publicPath.split("#", 2);
  const withoutExtension = pagePath.replace(/\.(md|mdx)$/i, "");
  const lastSegment = withoutExtension.split("/").at(-1) ?? withoutExtension;
  const title = familyTitle(anchor ?? lastSegment);
  const publicRoute = docsRouteIndex.routes.has(withoutExtension)
    ? withoutExtension
    : docsRouteIndex.redirects.get(withoutExtension);
  if (!publicRoute || !docsRouteIndex.routes.has(publicRoute)) {
    return undefined;
  }
  const publicHref = anchor ? `${publicRoute}#${anchor}` : publicRoute;
  return `[${markdownEscape(title)}](/${markdownEscape(publicHref)})`;
}

function scorePercent(value?: QaMaturityScoreObject): number | undefined {
  if (!value || typeof value !== "object" || !Number.isFinite(value.score)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, Math.round(value.score)));
}

function scoreClass(value?: QaMaturityScoreObject): string {
  const score = scorePercent(value);
  if (score === undefined) {
    return "maturity-score-unscored";
  }
  if (score >= 95) {
    return "maturity-score-clawesome";
  }
  if (score >= 80) {
    return "maturity-score-stable";
  }
  if (score >= 70) {
    return "maturity-score-beta";
  }
  if (score >= 50) {
    return "maturity-score-alpha";
  }
  return "maturity-score-experimental";
}

function scoreLabel(value?: QaMaturityScoreObject): string {
  if (!value || typeof value !== "object") {
    return "Unscored";
  }
  const label = maturityDisplayLabel(value.label ?? "Unscored");
  return `${label}${scorePercent(value) === undefined ? "" : ` - ${scorePercent(value)}%`}`;
}

function scoreMeter(value?: QaMaturityScoreObject): string {
  const score = scorePercent(value);
  if (score === undefined) {
    return '<span className="maturity-score maturity-score-unscored"><span className="maturity-score-label"><span>Unscored</span><span>-</span></span></span>';
  }
  return `<span className="maturity-score ${scoreClass(value)}"><span className="maturity-score-label">${maturityLabelPill(value?.label ?? "Unscored")}<span>${score}%</span></span><span className="maturity-meter" aria-hidden="true"><span style={{ width: "${score}%" }} /></span></span>`;
}

function scoreSummary(
  title: string,
  value: QaMaturityScoreObject | undefined,
  description: string,
  details: readonly string[] = [],
): string[] {
  const score = scorePercent(value);
  const displayScore = score === undefined ? "-" : `${score}%`;
  const cssScore = score === undefined ? "0" : String(score);
  return [
    `<div className="maturity-summary-item ${scoreClass(value)}">`,
    '  <div className="maturity-summary-heading">',
    `    <span className="maturity-summary-value">${displayScore}</span>`,
    `    <span>${markdownEscape(title)}</span>`,
    "  </div>",
    `  <div className="maturity-summary-bar" style={{ "--score": "${cssScore}" }}><span /></div>`,
    '  <div className="maturity-summary-meta">',
    `    ${maturityLabelPill(value?.label ?? "Unscored")}`,
    `    <span>${markdownEscape(description)}</span>`,
    ...details.map((detail) => `    <span>${markdownEscape(detail)}</span>`),
    "  </div>",
    "</div>",
  ];
}

function maturityLtsBadge(lts?: QaMaturityScoreSurfaceLts): string {
  if (!lts || typeof lts !== "object") {
    return '<span className="maturity-lts maturity-lts-none">Unscored</span>';
  }
  const supportedCategories = lts.supported_categories ?? 0;
  const status = lts.status ?? "unknown";
  const label = status === "full" ? "Full" : status === "partial" ? "Partial" : "None";
  const detail = status === "none" ? "" : ` - ${supportedCategories}`;
  return `<span className="maturity-lts maturity-lts-${status}">${label}${detail}</span>`;
}

function maturityLevelClass(code: RenderScalar): string {
  const level = String(code ?? "")
    .trim()
    .toUpperCase();
  if (level === "M5") {
    return "maturity-level-clawesome";
  }
  if (level === "M4") {
    return "maturity-level-stable";
  }
  if (level === "M3") {
    return "maturity-level-beta";
  }
  if (level === "M2") {
    return "maturity-level-alpha";
  }
  return "maturity-level-experimental";
}

function maturityLabelCode(label: RenderScalar): string | undefined {
  switch (
    String(label ?? "")
      .trim()
      .toLowerCase()
  ) {
    case "planned":
      return "M0";
    case "experimental":
      return "M1";
    case "alpha":
      return "M2";
    case "beta":
      return "M3";
    case "stable":
      return "M4";
    case "lovable":
    case "clawesome":
      return "M5";
    default:
      return undefined;
  }
}

function maturityDisplayLabel(label: RenderScalar): string {
  return String(label ?? "")
    .trim()
    .toLowerCase() === "lovable"
    ? "Clawesome"
    : String(label ?? "");
}

function maturityLabelPill(label: RenderScalar): string {
  const code = maturityLabelCode(label);
  if (!code) {
    return `<span className="maturity-score-label-text">${markdownEscape(maturityDisplayLabel(label))}</span>`;
  }
  return `<span className="maturity-level-pill ${maturityLevelClass(code)}">${markdownEscape(maturityDisplayLabel(label))}</span>`;
}

function maturityBandClass(label: RenderScalar): string {
  const code = maturityLabelCode(label);
  return code
    ? maturityLevelClass(code).replace("maturity-level-", "maturity-band-")
    : "maturity-band-experimental";
}

function maturityLevelPill(code: RenderScalar, label: RenderScalar): string {
  return `<span className="maturity-level-pill ${maturityLevelClass(code)}"><span className="maturity-level-code">${markdownEscape(code)}</span><span>${markdownEscape(maturityDisplayLabel(label))}</span></span>`;
}

function maturityLevelPillFromText(value: string): string {
  const match = value.trim().match(/^(M\d+)\s+(.+)$/i);
  if (!match) {
    return `<span className="maturity-level-pill maturity-level-experimental">${markdownEscape(value)}</span>`;
  }
  return maturityLevelPill(match[1], match[2]);
}

function indentMarkdown(lines: string[], spaces = 4): string[] {
  const prefix = " ".repeat(spaces);
  return lines.map((line) => (line ? `${prefix}${line}` : ""));
}

function renderSurfaceRows({
  coverage,
  levels,
  scoreSurfaces,
  surfaces,
}: {
  coverage: DerivedCoverageScores;
  levels: Map<string, QaMaturityTaxonomyLevel>;
  scoreSurfaces: Map<string, QaMaturityScoreSurface>;
  surfaces: QaMaturityTaxonomySurface[];
}): string[] {
  const rows = [
    '<div className="maturity-surface-table">',
    '  <div className="maturity-surface-row maturity-surface-row-header"><span>Surface</span><span>Coverage</span><span>Quality</span><span>Completeness</span><span>Support</span></div>',
  ];
  for (const surface of surfaces) {
    const scoreSurface = scoreSurfaces.get(surface.id);
    rows.push(
      '  <div className="maturity-surface-row">',
      `    <a className="maturity-surface-name" href="/maturity/taxonomy#${markdownSlug(surface.name)}"><span className="maturity-surface-title">${markdownEscape(surface.name)}</span><span className="maturity-surface-meta">${maturityLevelPillFromText(levelText(surface, levels))}<span>${surface.categories.length} areas</span></span></a>`,
      `    <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Coverage</span>${scoreMeter(coverage.surfaces.get(surface.id))}</div>`,
      `    <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Quality</span>${scoreMeter(scoreSurface?.scores?.quality)}</div>`,
      `    <div className="maturity-surface-metric"><span className="maturity-surface-metric-label">Completeness</span>${scoreMeter(scoreSurface?.scores?.completeness)}</div>`,
      `    <div className="maturity-surface-support">${maturityLtsBadge(scoreSurface?.lts)}</div>`,
      "  </div>",
    );
  }
  rows.push("</div>");
  return rows;
}

function renderSurfaceTabs({
  coverage,
  levels,
  scoreSurfaces,
  surfaces,
}: {
  coverage: DerivedCoverageScores;
  levels: Map<string, QaMaturityTaxonomyLevel>;
  scoreSurfaces: Map<string, QaMaturityScoreSurface>;
  surfaces: QaMaturityTaxonomySurface[];
}): string[] {
  const families = qaMaturityFamilyOrder(surfaces);
  const tabs = [
    "<Tabs>",
    '  <Tab title="All surfaces">',
    ...indentMarkdown(renderSurfaceRows({ coverage, levels, scoreSurfaces, surfaces })),
    "  </Tab>",
  ];
  for (const family of families) {
    tabs.push(
      `  <Tab title="${markdownEscape(familyTitle(family))}">`,
      ...indentMarkdown(
        renderSurfaceRows({
          coverage,
          levels,
          scoreSurfaces,
          surfaces: surfaces.filter((surface) => surface.family === family),
        }),
      ),
      "  </Tab>",
    );
  }
  tabs.push("</Tabs>");
  return tabs;
}

function levelText(
  surface: QaMaturityScoreSurface | QaMaturityTaxonomySurface,
  taxonomyLevels: Map<string, QaMaturityTaxonomyLevel>,
): string {
  const scoreLevel = surface.level;
  if (scoreLevel && typeof scoreLevel === "object") {
    return [scoreLevel.code, scoreLevel.label].filter(Boolean).join(" ");
  }
  const levelId = typeof scoreLevel === "string" ? scoreLevel : "";
  const level = taxonomyLevels.get(levelId);
  return [level?.code, level?.label ?? levelId].filter(Boolean).join(" ");
}

function maturityLevelRank(
  surface: QaMaturityTaxonomySurface,
  taxonomyLevels: Map<string, QaMaturityTaxonomyLevel>,
): number {
  const match = levelText(surface, taxonomyLevels).match(/M(\d+)/i);
  return match ? Number(match[1]) : -1;
}

function ltsRank(lts?: QaMaturityScoreSurfaceLts): number {
  if (lts?.status === "full") {
    return 0;
  }
  if (lts?.status === "partial") {
    return 1;
  }
  return 2;
}

function sortedMaturitySurfaces(
  surfaces: QaMaturityTaxonomySurface[],
  scoreSurfaces: Map<string, QaMaturityScoreSurface>,
  taxonomyLevels: Map<string, QaMaturityTaxonomyLevel>,
): QaMaturityTaxonomySurface[] {
  return surfaces.toSorted((left, right) => {
    const leftScore = scoreSurfaces.get(left.id);
    const rightScore = scoreSurfaces.get(right.id);
    const levelOrder =
      maturityLevelRank(right, taxonomyLevels) - maturityLevelRank(left, taxonomyLevels);
    if (levelOrder !== 0) {
      return levelOrder;
    }
    const completenessOrder =
      (rightScore?.scores.completeness.score ?? -1) - (leftScore?.scores.completeness.score ?? -1);
    if (completenessOrder !== 0) {
      return completenessOrder;
    }
    const qualityOrder =
      (rightScore?.scores.quality.score ?? -1) - (leftScore?.scores.quality.score ?? -1);
    if (qualityOrder !== 0) {
      return qualityOrder;
    }
    const ltsOrder = ltsRank(leftScore?.lts) - ltsRank(rightScore?.lts);
    if (ltsOrder !== 0) {
      return ltsOrder;
    }
    return left.name.localeCompare(right.name);
  });
}

function renderScoreBands(): string[] {
  return [
    "## Score bands",
    "",
    '<div className="maturity-band-list">',
    ...QA_MATURITY_SCORE_LABEL_BANDS.toReversed().map(
      ([label, low, high]) =>
        `  <div className="maturity-band ${maturityBandClass(label)}"><span className="maturity-band-title">${maturityLabelPill(label)}</span><span>${low}-${high}%</span></div>`,
    ),
    "</div>",
    "",
  ];
}

function latestScoreRunDate(scores: QaMaturityScores): string | undefined {
  const dates = scores.surfaces
    .map((surface) => surface.last_score_run?.completed_at)
    .filter((date): date is string => Boolean(date))
    .toSorted((left, right) => left.localeCompare(right));
  return dates.at(-1);
}

function frontmatter(title: string, summary: string): string[] {
  return ["---", `title: "${title}"`, `summary: "${summary}"`, "---", ""];
}

function surfaceScoreMap(scores: QaMaturityScores): Map<string, QaMaturityScoreSurface> {
  return new Map(scores.surfaces.map((surface) => [surface.id, surface]));
}

function categoryScoreMap(
  scoreSurface?: QaMaturityScoreSurface,
): Map<string, QaMaturityScoreSurface["categories"][number]> {
  return new Map((scoreSurface?.categories ?? []).map((category) => [category.name, category]));
}

function collectQaEvidenceFiles(root?: string): string[] {
  if (!root || !fs.existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name === "qa-evidence.json") {
        files.push(fullPath);
      }
    }
  };
  visit(root);
  return files.toSorted((left, right) => left.localeCompare(right));
}

function countStatuses(entries: QaEvidenceSummaryJson["entries"]): StatusCounts {
  const counts: StatusCounts = { ...EMPTY_STATUS_COUNTS };
  for (const entry of entries) {
    counts[entry.result.status] += 1;
  }
  return counts;
}

function blockingResultLabels(entries: QaEvidenceSummaryJson["entries"]): string[] {
  return entries
    .filter((entry) => entry.result.status === "fail" || entry.result.status === "blocked")
    .map((entry) => `${entry.test.id} (${entry.result.status})`);
}

function numberText(value: unknown): string {
  return Number.isFinite(value) ? String(value) : "";
}

function countText(counts?: PublicCount): string {
  if (!counts || typeof counts !== "object") {
    return "";
  }
  return `${counts.fulfilled ?? 0} of ${counts.total ?? 0} (${numberText(counts.fulfillmentPercent)}%)`;
}

function averageScores(
  scores: readonly QaMaturityScoreObject[],
): QaMaturityScoreObject | undefined {
  if (scores.length === 0) {
    return undefined;
  }
  const average = Math.round(scores.reduce((sum, score) => sum + score.score, 0) / scores.length);
  return qaMaturityScoreObjectForScore(average);
}

function checkSetTitle(profile: string): string {
  const normalized = profile.trim();
  if (normalized === "all") {
    return "Full taxonomy validation";
  }
  if (!normalized || normalized === "release") {
    return "Release validation";
  }
  return familyTitle(normalized);
}

function resultCountsText(statuses: StatusCounts): string {
  const parts = [`${statuses.pass} passed`];
  if (statuses.fail > 0) {
    parts.push(`${statuses.fail} failed`);
  }
  if (statuses.blocked > 0) {
    parts.push(`${statuses.blocked} blocked`);
  }
  if (statuses.skipped > 0) {
    parts.push(`${statuses.skipped} skipped`);
  }
  return parts.join(", ");
}

function readinessStatusText(status: string): string {
  if (status === "fulfilled") {
    return "Ready";
  }
  if (status === "partial") {
    return "Partially reviewed";
  }
  if (status === "missing") {
    return "Needs review";
  }
  return status;
}

function followUpText(missingCoverageCount: number): string {
  if (missingCoverageCount === 0) {
    return "None";
  }
  return `${missingCoverageCount} capability ${missingCoverageCount === 1 ? "gap" : "gaps"}`;
}

function publicCount(count: {
  fulfilled: number;
  total: number;
  fulfillmentPercent: number;
}): PublicCount {
  return {
    fulfilled: count.fulfilled,
    total: count.total,
    fulfillmentPercent: count.fulfillmentPercent,
  };
}

function publicScorecardFromEvidence(
  scorecard: NonNullable<QaEvidenceSummaryJson["scorecard"]>,
): PublicScorecard {
  return {
    categories: publicCount(scorecard.categories),
    features: publicCount(scorecard.features),
    coverageIds: publicCount(scorecard.coverageIds),
    categoryReports: scorecard.categoryReports.map((category) => ({
      surfaceId: category.surfaceId,
      name: category.name,
      status: category.status,
      features: publicCount(category.features),
      coverageIds: publicCount(category.coverageIds),
      missingCoverageCount: category.missingCoverageIds.length,
      docs: "",
    })),
  };
}

function readEvidenceSummaries(evidenceDir?: string): EvidenceSummary[] {
  return collectQaEvidenceFiles(evidenceDir).map((filePath) => {
    const payload = validateQaEvidenceSummaryJson(JSON.parse(fs.readFileSync(filePath, "utf8")));
    return {
      sourcePath: filePath,
      path: path.relative(process.cwd(), filePath),
      generatedAt: payload.generatedAt,
      profile: payload.profile ?? "",
      entryCount: payload.entries.length,
      statuses: countStatuses(payload.entries),
      blockingResults: blockingResultLabels(payload.entries),
      scorecard: payload.scorecard ? publicScorecardFromEvidence(payload.scorecard) : undefined,
    };
  });
}

function assertRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void {
  const actual = Object.keys(value).toSorted();
  const sortedExpected = expected.toSorted();
  if (actual.join("\0") !== sortedExpected.join("\0")) {
    throw new Error(
      `${context} must contain exactly: ${sortedExpected.join(", ")}; got: ${actual.join(", ")}`,
    );
  }
}

function readNonNegativeInteger(value: unknown, context: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${context} must be a non-negative integer`);
  }
  return value as number;
}

function readPercent(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${context} must be a finite percentage from 0 through 100`);
  }
  return value;
}

function readNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function readStateCount(value: unknown, context: string): StateCount {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${context} must be [fulfilled, total, fulfillmentPercent]`);
  }
  const fulfilled = readNonNegativeInteger(value[0], `${context}[0]`);
  const total = readNonNegativeInteger(value[1], `${context}[1]`);
  const fulfillmentPercent = readPercent(value[2], `${context}[2]`);
  if (fulfilled > total) {
    throw new Error(`${context} fulfilled count cannot exceed total`);
  }
  return [fulfilled, total, fulfillmentPercent];
}

function readStatusCounts(value: unknown, context: string): StatusCounts {
  const record = assertRecord(value, context);
  assertExactKeys(record, ["blocked", "fail", "pass", "skipped"], context);
  return {
    pass: readNonNegativeInteger(record.pass, `${context}.pass`),
    fail: readNonNegativeInteger(record.fail, `${context}.fail`),
    blocked: readNonNegativeInteger(record.blocked, `${context}.blocked`),
    skipped: readNonNegativeInteger(record.skipped, `${context}.skipped`),
  };
}

function readStateCategory(value: unknown, context: string): StateCategory {
  if (!Array.isArray(value) || value.length !== 11) {
    throw new Error(`${context} must be an 11-field category tuple`);
  }
  const surfaceName = readNonEmptyString(value[0], `${context}[0]`);
  const categoryName = readNonEmptyString(value[1], `${context}[1]`);
  const status = value[2];
  if (status !== "fulfilled" && status !== "partial" && status !== "missing") {
    throw new Error(`${context}[2] must be fulfilled, partial, or missing`);
  }
  const featureFulfilled = readNonNegativeInteger(value[3], `${context}[3]`);
  const featureTotal = readNonNegativeInteger(value[4], `${context}[4]`);
  const featurePercent = readPercent(value[5], `${context}[5]`);
  const coverageFulfilled = readNonNegativeInteger(value[6], `${context}[6]`);
  const coverageTotal = readNonNegativeInteger(value[7], `${context}[7]`);
  const coveragePercent = readPercent(value[8], `${context}[8]`);
  const missingCoverageCount = readNonNegativeInteger(value[9], `${context}[9]`);
  const docs = typeof value[10] === "string" ? value[10] : undefined;
  if (docs === undefined || /[\r\n]/u.test(docs)) {
    throw new Error(`${context}[10] must be a single-line public docs projection`);
  }
  if (featureFulfilled > featureTotal || coverageFulfilled > coverageTotal) {
    throw new Error(`${context} fulfilled counts cannot exceed their totals`);
  }
  if (missingCoverageCount > coverageTotal) {
    throw new Error(`${context} missing coverage count cannot exceed its total`);
  }
  return [
    surfaceName,
    categoryName,
    status,
    featureFulfilled,
    featureTotal,
    featurePercent,
    coverageFulfilled,
    coverageTotal,
    coveragePercent,
    missingCoverageCount,
    docs,
  ];
}

function taxonomyCategoryOrder(taxonomy: QaMaturityTaxonomy): Array<[string, string, string]> {
  return activeQaMaturityTaxonomySurfaces(taxonomy)
    .flatMap((surface) =>
      surface.categories.map((category) => ({
        sortKey: `${surface.id}.${category.id}`,
        tuple: [surface.id, surface.name, category.name] as [string, string, string],
      })),
    )
    .toSorted((left, right) => left.sortKey.localeCompare(right.sortKey))
    .map((entry) => entry.tuple);
}

function readMaturityDocsState(statePath: string, taxonomy: QaMaturityTaxonomy): MaturityDocsState {
  if (!fs.existsSync(statePath)) {
    throw new Error(
      `maturity docs state is missing at ${statePath}; pass --state or generate it from QA evidence with --evidence-dir and --state-output`,
    );
  }
  const root = assertRecord(JSON.parse(fs.readFileSync(statePath, "utf8")), statePath);
  assertExactKeys(root, ["summaries", "version"], statePath);
  if (root.version !== 1) {
    throw new Error(`${statePath}.version must be 1`);
  }
  if (!Array.isArray(root.summaries) || root.summaries.length === 0) {
    throw new Error(`${statePath}.summaries must be a non-empty array`);
  }

  const categoryOrder = taxonomyCategoryOrder(taxonomy);
  const knownCategories = new Set(
    categoryOrder.map(([, surfaceName, categoryName]) => `${surfaceName}\0${categoryName}`),
  );
  const summaries = root.summaries.map((rawSummary, summaryIndex): MaturityDocsStateSummary => {
    const context = `${statePath}.summaries[${summaryIndex}]`;
    const summary = assertRecord(rawSummary, context);
    assertExactKeys(
      summary,
      ["categories", "entryCount", "generatedAt", "profile", "statuses", "totals"],
      context,
    );
    const entryCount = readNonNegativeInteger(summary.entryCount, `${context}.entryCount`);
    const generatedAt = readNonEmptyString(summary.generatedAt, `${context}.generatedAt`);
    if (!Number.isFinite(Date.parse(generatedAt))) {
      throw new Error(`${context}.generatedAt must be an ISO timestamp`);
    }
    const profile = readNonEmptyString(summary.profile, `${context}.profile`);
    const statuses = readStatusCounts(summary.statuses, `${context}.statuses`);
    if (Object.values(statuses).reduce((sum, count) => sum + count, 0) !== entryCount) {
      throw new Error(`${context}.statuses must sum to entryCount`);
    }
    const totalsRecord = assertRecord(summary.totals, `${context}.totals`);
    assertExactKeys(totalsRecord, ["categories", "coverageIds", "features"], `${context}.totals`);
    const totals = {
      categories: readStateCount(totalsRecord.categories, `${context}.totals.categories`),
      coverageIds: readStateCount(totalsRecord.coverageIds, `${context}.totals.coverageIds`),
      features: readStateCount(totalsRecord.features, `${context}.totals.features`),
    };
    if (!Array.isArray(summary.categories)) {
      throw new Error(`${context}.categories must be an array`);
    }
    const categories = summary.categories.map((category, categoryIndex) =>
      readStateCategory(category, `${context}.categories[${categoryIndex}]`),
    );
    if (totals.categories[1] !== categories.length) {
      throw new Error(`${context}.totals.categories total must equal the category tuple count`);
    }
    const seen = new Set<string>();
    for (const [surfaceName, categoryName] of categories) {
      const key = `${surfaceName}\0${categoryName}`;
      if (!knownCategories.has(key)) {
        throw new Error(
          `${context} contains unknown taxonomy category ${surfaceName} / ${categoryName}`,
        );
      }
      if (seen.has(key)) {
        throw new Error(
          `${context} contains duplicate taxonomy category ${surfaceName} / ${categoryName}`,
        );
      }
      seen.add(key);
    }
    if (profile === "all" && categories.length !== categoryOrder.length) {
      throw new Error(
        `${context} all-profile state covers ${categories.length} of ${categoryOrder.length} active taxonomy categories`,
      );
    }
    return { categories, entryCount, generatedAt, profile, statuses, totals };
  });

  const sorted = summaries.toSorted(
    (left, right) =>
      left.profile.localeCompare(right.profile) ||
      left.generatedAt.localeCompare(right.generatedAt),
  );
  if (summaries.some((summary, index) => summary !== sorted[index])) {
    throw new Error(`${statePath}.summaries must be sorted by profile and generatedAt`);
  }
  return { summaries, version: 1 };
}

function stateCount(count: PublicCount): StateCount {
  return [count.fulfilled, count.total, count.fulfillmentPercent];
}

function maturityDocsStateFromEvidence(
  taxonomy: QaMaturityTaxonomy,
  evidenceSummaries: EvidenceSummary[],
  docsRouteIndex: DocsRouteIndex,
): MaturityDocsState {
  const surfaceNames = new Map(
    activeQaMaturityTaxonomySurfaces(taxonomy).map((surface) => [surface.id, surface.name]),
  );
  const categoryOrder = taxonomyCategoryOrder(taxonomy);
  const docsByKey = new Map(
    activeQaMaturityTaxonomySurfaces(taxonomy).flatMap((surface) =>
      surface.categories.map((category) => [
        `${surface.name}\0${category.name}`,
        (category.docs ?? [])
          .map((doc) => docsLink(doc, docsRouteIndex))
          .filter((doc): doc is string => Boolean(doc))
          .join(", "),
      ]),
    ),
  );
  const summaries = evidenceSummaries
    .filter((summary): summary is EvidenceSummary & { scorecard: PublicScorecard } =>
      Boolean(summary.scorecard),
    )
    .map((summary): MaturityDocsStateSummary => {
      const categoriesByKey = new Map<string, StateCategory>();
      for (const category of summary.scorecard.categoryReports) {
        const surfaceName = surfaceNames.get(category.surfaceId);
        if (!surfaceName) {
          throw new Error(`QA evidence contains unknown taxonomy surface ${category.surfaceId}`);
        }
        const key = `${surfaceName}\0${category.name}`;
        if (categoriesByKey.has(key)) {
          throw new Error(
            `QA evidence contains duplicate taxonomy category ${surfaceName} / ${category.name}`,
          );
        }
        categoriesByKey.set(key, [
          surfaceName,
          category.name,
          category.status,
          category.features.fulfilled,
          category.features.total,
          category.features.fulfillmentPercent,
          category.coverageIds.fulfilled,
          category.coverageIds.total,
          category.coverageIds.fulfillmentPercent,
          category.missingCoverageCount,
          docsByKey.get(key) ?? "",
        ]);
      }
      const categories = categoryOrder.flatMap(([, surfaceName, categoryName]) => {
        const category = categoriesByKey.get(`${surfaceName}\0${categoryName}`);
        return category ? [category] : [];
      });
      if (categories.length !== categoriesByKey.size) {
        throw new Error("QA evidence contains a category that is absent from the active taxonomy");
      }
      if (summary.profile === "all" && categories.length !== categoryOrder.length) {
        throw new Error(
          `all-profile QA evidence covers ${categories.length} of ${categoryOrder.length} active taxonomy categories`,
        );
      }
      if (summary.scorecard.categories.total !== categories.length) {
        throw new Error(
          `QA evidence category total ${summary.scorecard.categories.total} does not match ${categories.length} projected rows`,
        );
      }
      if (
        Object.values(summary.statuses).reduce((sum, count) => sum + count, 0) !==
        summary.entryCount
      ) {
        throw new Error("QA evidence status counts do not sum to the evidence entry count");
      }
      return {
        categories,
        entryCount: summary.entryCount,
        generatedAt: summary.generatedAt,
        profile: summary.profile,
        statuses: summary.statuses,
        totals: {
          categories: stateCount(summary.scorecard.categories),
          coverageIds: stateCount(summary.scorecard.coverageIds),
          features: stateCount(summary.scorecard.features),
        },
      };
    })
    .toSorted(
      (left, right) =>
        left.profile.localeCompare(right.profile) ||
        left.generatedAt.localeCompare(right.generatedAt),
    );
  if (summaries.length === 0) {
    throw new Error("QA evidence does not contain a scorecard to project into maturity docs state");
  }
  return { summaries, version: 1 };
}

function publicCountFromState([fulfilled, total, fulfillmentPercent]: StateCount): PublicCount {
  return { fulfilled, total, fulfillmentPercent };
}

function evidenceSummariesFromState(
  state: MaturityDocsState,
  statePath: string,
  taxonomy: QaMaturityTaxonomy,
): EvidenceSummary[] {
  const surfaceIds = new Map(
    activeQaMaturityTaxonomySurfaces(taxonomy).map((surface) => [surface.name, surface.id]),
  );
  return state.summaries.map((summary, index) => ({
    sourcePath: statePath,
    path: `${statePath}#summaries[${index}]`,
    generatedAt: summary.generatedAt,
    profile: summary.profile,
    entryCount: summary.entryCount,
    statuses: summary.statuses,
    blockingResults: [],
    scorecard: {
      categories: publicCountFromState(summary.totals.categories),
      coverageIds: publicCountFromState(summary.totals.coverageIds),
      features: publicCountFromState(summary.totals.features),
      categoryReports: summary.categories.map(
        ([
          surfaceName,
          name,
          status,
          featureFulfilled,
          featureTotal,
          featurePercent,
          coverageFulfilled,
          coverageTotal,
          coveragePercent,
          missingCoverageCount,
          docs,
        ]) => ({
          surfaceId: surfaceIds.get(surfaceName) ?? surfaceName,
          name,
          status,
          features: {
            fulfilled: featureFulfilled,
            total: featureTotal,
            fulfillmentPercent: featurePercent,
          },
          coverageIds: {
            fulfilled: coverageFulfilled,
            total: coverageTotal,
            fulfillmentPercent: coveragePercent,
          },
          missingCoverageCount,
          docs,
        }),
      ),
    },
  }));
}

function formatMaturityDocsState(state: MaturityDocsState): string {
  const lines = ["{", '  "summaries": ['];
  for (const [summaryIndex, summary] of state.summaries.entries()) {
    lines.push(
      "    {",
      '      "categories": [',
      ...summary.categories.map(
        (category, categoryIndex) =>
          `        ${JSON.stringify(category)}${categoryIndex + 1 === summary.categories.length ? "" : ","}`,
      ),
      "      ],",
      `      "entryCount": ${summary.entryCount},`,
      `      "generatedAt": ${JSON.stringify(summary.generatedAt)},`,
      `      "profile": ${JSON.stringify(summary.profile)},`,
      '      "statuses": {',
      `        "blocked": ${summary.statuses.blocked},`,
      `        "fail": ${summary.statuses.fail},`,
      `        "pass": ${summary.statuses.pass},`,
      `        "skipped": ${summary.statuses.skipped}`,
      "      },",
      '      "totals": {',
      `        "categories": ${JSON.stringify(summary.totals.categories)},`,
      `        "coverageIds": ${JSON.stringify(summary.totals.coverageIds)},`,
      `        "features": ${JSON.stringify(summary.totals.features)}`,
      "      }",
      `    }${summaryIndex + 1 === state.summaries.length ? "" : ","}`,
    );
  }
  lines.push("  ],", '  "version": 1', "}");
  return `${lines.join("\n")}\n`;
}

function writeFileAtomic(outputPath: string, content: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    // Rename only after the complete projection is durable, so interruption cannot expose half JSON.
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function rejectBlockingEvidence(evidenceSummaries: EvidenceSummary[]): void {
  const blocked = evidenceSummaries.filter((item) => item.blockingResults.length > 0);
  if (blocked.length === 0) {
    return;
  }
  throw new Error(
    [
      "maturity docs require passing QA evidence; failing or blocked QA entries cannot be rendered into the scorecard.",
      ...blocked.map((item) => {
        const counts = [
          item.statuses.fail > 0 ? `${item.statuses.fail} failed` : undefined,
          item.statuses.blocked > 0 ? `${item.statuses.blocked} blocked` : undefined,
        ]
          .filter(Boolean)
          .join(", ");
        return `${item.path}: ${counts}; ${item.blockingResults.join(", ")}`;
      }),
    ].join("\n"),
  );
}

function latestCoverageScorecard(
  evidenceSummaries: EvidenceSummary[],
): EvidenceSummary | undefined {
  for (const profile of ["all", "release"]) {
    const latest = evidenceSummaries
      .filter((item) => item.profile === profile && item.scorecard)
      .toSorted((left, right) => left.generatedAt.localeCompare(right.generatedAt))
      .at(-1);
    if (latest) {
      return latest;
    }
  }
  return undefined;
}

function deriveCoverageScores(
  taxonomy: QaMaturityTaxonomy,
  evidenceSummaries: EvidenceSummary[],
): DerivedCoverageScores {
  const warnings: string[] = [];
  const coverageSummary = latestCoverageScorecard(evidenceSummaries);
  if (!coverageSummary) {
    throw new Error(
      "maturity scorecard rendering requires all or release profile qa-evidence.json with a scorecard field; pass --evidence-dir with QA evidence artifacts",
    );
  }
  const selectedProfileScorecardSummaries = evidenceSummaries.filter(
    (item) => item.profile === coverageSummary.profile && item.scorecard,
  );
  if (selectedProfileScorecardSummaries.length > 1) {
    warnings.push(
      `multiple ${coverageSummary.profile} profile evidence scorecards found; using latest from ${coverageSummary.path}`,
    );
  }

  const categories = new Map<string, QaMaturityScoreObject>();
  const categoryDocs = new Map<string, string>();
  const categoryFeatureTotals = new Map<string, number>();
  for (const report of coverageSummary.scorecard?.categoryReports ?? []) {
    const key = qaMaturityCoverageCategoryKey(report.surfaceId, report.name);
    categories.set(
      key,
      qaMaturityScoreObjectForScore(Math.round(report.coverageIds.fulfillmentPercent)),
    );
    categoryDocs.set(key, report.docs);
    categoryFeatureTotals.set(key, report.features.total);
  }

  const surfaces = new Map<string, QaMaturityScoreObject>();
  for (const surface of activeQaMaturityTaxonomySurfaces(taxonomy)) {
    const categoryScores = surface.categories
      .map((category) => {
        const key = qaMaturityCoverageCategoryKey(surface.id, category.name);
        return categories.get(key);
      })
      .filter((score): score is QaMaturityScoreObject => Boolean(score));
    if (categoryScores.length === surface.categories.length) {
      const surfaceScore = averageScores(categoryScores);
      if (surfaceScore) {
        surfaces.set(surface.id, surfaceScore);
      }
    }
  }

  const activeSurfaces = activeQaMaturityTaxonomySurfaces(taxonomy);
  const expectedCategoryCount = activeSurfaces.reduce(
    (count, surface) => count + surface.categories.length,
    0,
  );
  if (coverageSummary.profile === "all" && categories.size !== expectedCategoryCount) {
    warnings.push(
      `${coverageSummary.path}: all profile evidence covers ${categories.size} of ${expectedCategoryCount} active taxonomy categories`,
    );
  }
  const categoryScores = Array.from(categories.values());
  const surfaceScores = Array.from(surfaces.values());
  return {
    categories,
    categoryDocs,
    categoryFeatureTotals,
    surfaces,
    rollups: {
      category_average:
        categoryScores.length === expectedCategoryCount ? averageScores(categoryScores) : undefined,
      surface_average:
        surfaceScores.length === activeSurfaces.length ? averageScores(surfaceScores) : undefined,
    },
    warnings,
  };
}

function evidenceScorecardWarnings(
  evidenceSummaries: EvidenceSummary[],
  coverage: DerivedCoverageScores,
): string[] {
  return [
    ...evidenceSummaries
      .filter((item) => (item.profile === "all" || item.profile === "release") && !item.scorecard)
      .map(
        (item) =>
          `${item.path}: ${item.profile} profile qa-evidence.json does not include a scorecard field; run pnpm openclaw qa run --qa-profile ${item.profile} to produce deterministic scorecard rows`,
      ),
    ...coverage.warnings,
  ];
}

function writeInputWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
}

function enforceStrictInputs(warnings: string[]): void {
  if (warnings.length === 0) {
    return;
  }
  throw new Error(
    `strict input validation failed:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`,
  );
}

function copyStaticSourceAssets({
  evidenceSummaries,
  scoresPath,
  staticAssetsDir,
  taxonomyPath,
}: {
  evidenceSummaries: EvidenceSummary[];
  scoresPath: string;
  staticAssetsDir: string;
  taxonomyPath: string;
}): string[] {
  fs.mkdirSync(staticAssetsDir, { recursive: true });
  const copied: Array<[string, string]> = [
    [taxonomyPath, path.join(staticAssetsDir, "taxonomy.yaml")],
    [scoresPath, path.join(staticAssetsDir, "maturity-scores.yaml")],
  ];
  const evidenceDir = path.join(staticAssetsDir, "evidence");
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  if (evidenceSummaries.length > 0) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }
  for (const [index, evidence] of evidenceSummaries.entries()) {
    copied.push([
      evidence.sourcePath,
      path.join(evidenceDir, `qa-evidence-${String(index + 1).padStart(2, "0")}.json`),
    ]);
  }
  for (const [source, target] of copied) {
    fs.copyFileSync(source, target);
  }
  return copied.map(([, target]) => target);
}

function surfaceNameMap(surfaces: QaMaturityTaxonomySurface[]): Map<string, string> {
  return new Map(surfaces.map((surface) => [surface.id, surface.name]));
}

function renderEvidenceSection(
  evidenceSummaries: EvidenceSummary[],
  surfaceNames: Map<string, string>,
): string[] {
  const scorecardSummaries = evidenceSummaries.filter((item) => item.scorecard);
  if (scorecardSummaries.length === 0) {
    return [];
  }
  const lines = [
    "## QA evidence summary",
    "",
    "The checks below show which scorecard areas were exercised by QA profile evidence.",
    "",
  ];

  lines.push('<div className="maturity-evidence-grid">');
  for (const item of scorecardSummaries) {
    const scorecard = item.scorecard;
    lines.push(
      '  <div className="maturity-evidence-card">',
      `    <span className="maturity-evidence-title">${markdownEscape(checkSetTitle(item.profile))}</span>`,
      `    <span>${markdownEscape(item.generatedAt)}</span>`,
      `    <span>${item.entryCount} checks - ${markdownEscape(resultCountsText(item.statuses))}</span>`,
      `    <span>${markdownEscape(countText(scorecard?.categories))} areas - ${markdownEscape(countText(scorecard?.features))} features - ${markdownEscape(countText(scorecard?.coverageIds))} coverage IDs</span>`,
      "  </div>",
    );
  }
  lines.push("</div>", "");

  const categoryRows = scorecardSummaries.flatMap((item) =>
    (item.scorecard?.categoryReports ?? []).map((category) => ({ item, category })),
  );
  if (categoryRows.length > 0) {
    const grouped = new Map<string, Array<(typeof categoryRows)[number]>>();
    for (const row of categoryRows) {
      const existing = grouped.get(row.category.surfaceId) ?? [];
      existing.push(row);
      grouped.set(row.category.surfaceId, existing);
    }
    lines.push(
      "### Readiness by area",
      "",
      "Open a surface to inspect the evidence state of each category. The list stays collapsed so the page remains useful at a glance.",
      "",
      "<AccordionGroup>",
    );
    for (const [surfaceId, rows] of grouped) {
      const surfaceName = surfaceNames.get(surfaceId) ?? familyTitle(surfaceId);
      const statusCounts = rows.reduce<Record<string, number>>((counts, row) => {
        counts[readinessStatusText(row.category.status)] =
          (counts[readinessStatusText(row.category.status)] ?? 0) + 1;
        return counts;
      }, {});
      const summary = Object.entries(statusCounts)
        .map(([status, count]) => `${count} ${status.toLowerCase()}`)
        .join(" / ");
      lines.push(
        `  <Accordion title="${markdownEscape(surfaceName)} - ${rows.length} areas">`,
        `    <p className="maturity-readiness-summary">${markdownEscape(summary)}</p>`,
        '    <div className="maturity-readiness-list">',
        '      <div className="maturity-readiness-row maturity-readiness-row-header"><span>Area</span><span>Features / coverage IDs</span><span>Follow-up</span></div>',
      );
      for (const { item, category } of rows) {
        const status = readinessStatusText(category.status);
        lines.push(
          '      <div className="maturity-readiness-row">',
          '        <div className="maturity-readiness-area">',
          `          <span className="maturity-readiness-title">${markdownEscape(category.name)}</span>`,
          `          <span className="maturity-readiness-status maturity-readiness-status-${markdownSlug(status)}">${markdownEscape(status)} - ${markdownEscape(checkSetTitle(item.profile))}</span>`,
          "        </div>",
          `        <span>${markdownEscape(countText(category.features))} / ${markdownEscape(countText(category.coverageIds))}</span>`,
          `        <span>${markdownEscape(followUpText(category.missingCoverageCount))}</span>`,
          "      </div>",
        );
      }
      lines.push("    </div>", "  </Accordion>", "");
    }
    lines.push("</AccordionGroup>", "");
  }
  return lines;
}

function renderMaturityScorecard({
  coverage,
  taxonomy,
  scores,
  evidenceSummaries,
}: RenderMaturityScorecardInputs): string {
  const levels = qaMaturityTaxonomyLevelMap(taxonomy);
  const scoreSurfaces = surfaceScoreMap(scores);
  const surfaces = sortedMaturitySurfaces(
    activeQaMaturityTaxonomySurfaces(taxonomy),
    scoreSurfaces,
    levels,
  );
  const surfaceNames = surfaceNameMap(surfaces);
  const updatedDate = latestScoreRunDate(scores);
  const surfaceAverage = coverage.rollups.surface_average;
  const qualityAverage = scores.rollups.surface_average.quality;
  const completenessAverage = scores.rollups.surface_average.completeness;
  const maturityAverage = averageScores([qualityAverage, completenessAverage]);
  const lines = [
    ...frontmatter(
      "Maturity scorecard",
      "OpenClaw release readiness scores for product areas, integrations, and supported workflows.",
    ),
    "# Maturity scorecard",
    "",
    '<div className="maturity-hero">',
    '  <p className="maturity-kicker">release readiness - generated from taxonomy + QA evidence</p>',
    '  <p className="maturity-hero-title">A practical view of what is ready, what is proven, and what still needs work.</p>',
    `  <p>${scores.counts.active_surfaces} surfaces - ${scores.counts.category_scores} capability areas - deterministic coverage plus human-reviewed quality and completeness.</p>`,
    '  <p className="maturity-jump-links"><a href="#surface-explorer">Browse surfaces</a> / <a href="#qa-evidence-summary">Inspect QA evidence</a> / <a href="/maturity/taxonomy">Read the taxonomy</a></p>',
    "</div>",
    "",
    "## What this page is for",
    "",
    "Use this page to answer one question: which OpenClaw surfaces are credible choices for a release, and what evidence supports that judgment? Coverage comes from deterministic QA evidence; quality and completeness are maintained as reviewed maturity scores.",
    "",
    "## At a glance",
    "",
    '<div className="maturity-summary-grid">',
    ...indentMarkdown(
      scoreSummary("Maturity score", maturityAverage, "Quality + completeness", [
        `Coverage ${scoreLabel(surfaceAverage)}`,
        `Quality ${scoreLabel(qualityAverage)}`,
        `Completeness ${scoreLabel(completenessAverage)}`,
      ]),
      2,
    ),
    "</div>",
    "",
    'Coverage is deliberately evidence-led: an area does not become "ready" just because the implementation exists. It is not an input to the maturity score, but OpenClaw aims to keep end-to-end coverage above 90% for mature Stable-or-better features over time.',
    "",
    ...renderScoreBands(),
  ];

  lines.push(
    "## Surface explorer",
    "",
    '<a id="surface-explorer" />',
    "",
    "Surfaces are ordered by maturity level, completeness, and quality. LTS support is shown alongside each row so release-ready options are easy to compare.",
    "",
    ...renderSurfaceTabs({ coverage, levels, scoreSurfaces, surfaces }),
    "",
    ...renderEvidenceSection(evidenceSummaries, surfaceNames),
  );
  if (updatedDate) {
    lines.push(`> Last updated: ${updatedDate}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderTaxonomy({
  coverage,
  docsRouteIndex,
  scores,
  taxonomy,
}: RenderInputs & { docsRouteIndex: DocsRouteIndex }): string {
  const levels = qaMaturityTaxonomyLevelMap(taxonomy);
  const scoreSurfaces = surfaceScoreMap(scores);
  const surfaces = sortedMaturitySurfaces(
    activeQaMaturityTaxonomySurfaces(taxonomy),
    scoreSurfaces,
    levels,
  );
  const lines = [
    ...frontmatter(
      "Maturity taxonomy",
      "Detailed reference for the product areas and checks behind the OpenClaw maturity scorecard.",
    ),
    "# Maturity taxonomy",
    "",
    '<div className="maturity-hero maturity-hero-compact">',
    '  <p className="maturity-kicker">the model behind the scorecard</p>',
    '  <p className="maturity-hero-title">Surfaces &gt; categories &gt; capabilities &gt; evidence.</p>',
    `  <p>${surfaces.length} surfaces grouped into ${qaMaturityFamilyOrder(surfaces).length} families, with every category tied back to canonical docs and QA coverage IDs.</p>`,
    '  <p className="maturity-jump-links"><a href="#product-areas">Browse product areas</a> / <a href="#taxonomy-details">Open detailed taxonomy</a> / <a href="/maturity/scorecard">View scores</a></p>',
    "</div>",
    "",
    "## How to read this page",
    "",
    "A surface is a product area such as Gateway runtime, Discord, or the macOS app. Each surface contains categories, and each category contains the capability-level checks that QA scenarios cover. Use the scorecard for release-level judgment; use this page to inspect the model underneath it.",
    "",
    "## Maturity levels",
    "",
    '<div className="maturity-level-list">',
    ...taxonomy.levels.map(
      (level) =>
        `  <div className="maturity-level-row"><span className="maturity-level-title">${maturityLevelPill(level.code ?? level.id, level.label ?? level.id)}</span><span>${markdownEscape(level.meaning ?? "")}</span><span className="maturity-level-promotion">Promotion: ${markdownEscape(level.promotion_bar ?? "")}</span></div>`,
    ),
    "</div>",
    "",
    "## Product areas",
    "",
    '<a id="product-areas" />',
    "",
  ];

  const families = qaMaturityFamilyOrder(surfaces);
  lines.push("<Tabs>");
  for (const family of families) {
    lines.push(`  <Tab title="${markdownEscape(familyTitle(family))}">`, "");
    for (const surface of surfaces.filter((candidate) => candidate.family === family)) {
      const scoreSurface = scoreSurfaces.get(surface.id);
      lines.push(
        ...indentMarkdown(
          [
            `<a className="maturity-surface-link" href="#${markdownSlug(surface.name)}">`,
            `  <span className="maturity-surface-title">${markdownEscape(surface.name)}</span>`,
            `  <span className="maturity-surface-meta">${maturityLevelPillFromText(levelText(surface, levels))}<span>${surface.categories.length} areas - ${scorePercent(scoreSurface?.scores?.completeness) ?? "-"}% complete</span></span>`,
            "</a>",
          ],
          4,
        ),
      );
      lines.push("");
    }
    lines.push("  </Tab>");
  }
  lines.push("</Tabs>", "", "## Details", "", '<a id="taxonomy-details" />', "");

  for (const family of families) {
    lines.push(`### ${familyTitle(family)}`, "", "<AccordionGroup>");
    for (const surface of surfaces.filter((candidate) => candidate.family === family)) {
      const surfaceName = surface.name;
      const scoreSurface = scoreSurfaces.get(surface.id);
      const categoryScores = categoryScoreMap(scoreSurface);
      const categoryLines = [
        '<div className="maturity-category-list">',
        '  <div className="maturity-category-row maturity-category-row-header"><span>Area</span><span>Coverage</span><span>Quality</span><span>Completeness</span><span>Docs</span></div>',
      ];
      for (const category of surface.categories) {
        const categoryKey = qaMaturityCoverageCategoryKey(surface.id, category.name);
        const docs =
          coverage.categoryDocs.get(categoryKey) ??
          (category.docs ?? [])
            .map((doc) => docsLink(doc, docsRouteIndex))
            .filter((doc): doc is string => Boolean(doc))
            .join(", ");
        const scoreCategory = categoryScores.get(category.name);
        const coverageScore = coverage.categories.get(categoryKey);
        categoryLines.push(
          '  <div className="maturity-category-row">',
          '    <div className="maturity-category-area">',
          `      <span className="maturity-category-title">${markdownEscape(category.name)}</span>`,
          `      <span>${coverage.categoryFeatureTotals.get(categoryKey) ?? category.features.length} capabilities${scoreCategory?.lts?.supported ? " / LTS-supported" : ""}</span>`,
          "    </div>",
          `    <div>${scoreMeter(coverageScore)}</div>`,
          `    <div>${scoreMeter(scoreCategory?.quality)}</div>`,
          `    <div>${scoreMeter(scoreCategory?.completeness)}</div>`,
          '    <div className="maturity-category-docs">',
          "",
          docs || "No linked docs",
          "",
          "</div>",
          "  </div>",
        );
      }
      categoryLines.push("</div>");
      lines.push(
        `  <Accordion title="${markdownEscape(surfaceName)} - ${markdownEscape(levelText(surface, levels))} - ${surface.categories.length} areas">`,
        `    <a id="${markdownSlug(surfaceName)}" />`,
        "",
        `    ${markdownEscape(surface.rationale ?? "")}`,
        "",
        ...indentMarkdown(
          [
            `<div className="maturity-surface-rollup"><span>Coverage ${scoreLabel(coverage.surfaces.get(surface.id))}</span><span>Quality ${scoreLabel(scoreSurface?.scores?.quality)}</span><span>Completeness ${scoreLabel(scoreSurface?.scores?.completeness)}</span><span>${maturityLtsBadge(scoreSurface?.lts)}</span></div>`,
            "",
            ...categoryLines,
            "",
          ],
          4,
        ),
        "  </Accordion>",
      );
      lines.push("");
    }
    lines.push("</AccordionGroup>", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function writeOrCheck(outputPath: string, content: string, check: boolean): boolean {
  const oldContent = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (check) {
    if (oldContent !== content) {
      throw new Error(`${outputPath} is stale; run pnpm maturity:render`);
    }
    return false;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (oldContent !== content) {
    fs.writeFileSync(outputPath, content);
    return true;
  }
  return false;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const taxonomyPath = path.normalize(args.taxonomy);
  const scoresPath = path.normalize(args.scores);
  const statePath = path.normalize(args.statePath);
  const stateOutput = args.stateOutput ? path.normalize(args.stateOutput) : undefined;
  const docsRoot = path.normalize(args.docsRoot);
  const outputDir = path.normalize(args.outputDir);
  const taxonomy = readQaMaturityTaxonomySource(taxonomyPath);
  const docsRouteIndex = collectDocsRouteIndex(docsRoot);
  const rawEvidenceSummaries = args.evidenceDir
    ? readEvidenceSummaries(path.normalize(args.evidenceDir))
    : undefined;
  if (rawEvidenceSummaries) {
    rejectBlockingEvidence(rawEvidenceSummaries);
  }
  const state = rawEvidenceSummaries
    ? maturityDocsStateFromEvidence(taxonomy, rawEvidenceSummaries, docsRouteIndex)
    : readMaturityDocsState(statePath, taxonomy);
  const evidenceSummaries = evidenceSummariesFromState(state, stateOutput ?? statePath, taxonomy);
  const coverage = deriveCoverageScores(taxonomy, evidenceSummaries);
  const { scores, warnings: scoreWarnings } = readValidatedQaMaturityScoreSources({
    coverageScores: coverage,
    scoresPath,
    taxonomy,
    taxonomyPath,
  });
  const evidenceWarnings = evidenceScorecardWarnings(evidenceSummaries, coverage);
  const inputWarnings = [...scoreWarnings, ...evidenceWarnings];
  writeInputWarnings(inputWarnings);
  if (args.strictInputs) {
    enforceStrictInputs(inputWarnings);
  }
  const copiedStaticAssets =
    !args.check && args.staticAssetsDir && rawEvidenceSummaries
      ? copyStaticSourceAssets({
          evidenceSummaries: rawEvidenceSummaries,
          scoresPath,
          staticAssetsDir: args.staticAssetsDir,
          taxonomyPath,
        })
      : [];
  const outputs = new Map<string, string>([
    [
      "maturity/scorecard.md",
      renderMaturityScorecard({
        coverage,
        taxonomy,
        scores,
        evidenceSummaries,
      }),
    ],
    [
      "maturity/taxonomy.md",
      renderTaxonomy({
        coverage,
        docsRouteIndex,
        taxonomy,
        scores,
      }),
    ],
  ]);
  const changed: string[] = [];
  if (!args.check || args.outputDirExplicit) {
    for (const [fileName, content] of outputs) {
      const outputPath = path.join(outputDir, fileName);
      if (writeOrCheck(outputPath, content, args.check)) {
        changed.push(outputPath);
      }
    }
  }
  const formattedState = formatMaturityDocsState(state);
  if (args.check && !rawEvidenceSummaries) {
    if (fs.readFileSync(statePath, "utf8") !== formattedState) {
      throw new Error(`${statePath} is not canonically formatted; regenerate it from QA evidence`);
    }
  } else if (!args.check && stateOutput) {
    writeFileAtomic(stateOutput, formattedState);
  }
  if (args.check && args.outputDirExplicit) {
    process.stdout.write(`maturity docs are up to date in ${outputDir}\n`);
  } else if (args.check) {
    process.stdout.write(`maturity docs inputs and sanitized state are valid\n`);
  } else if (changed.length > 0) {
    process.stdout.write(
      `rendered maturity docs:\n${changed.map((file) => `- ${file}`).join("\n")}\n`,
    );
  } else {
    process.stdout.write(`maturity docs already up to date in ${outputDir}\n`);
  }
  if (copiedStaticAssets.length > 0) {
    process.stdout.write(
      `copied maturity static assets:\n${copiedStaticAssets.map((file) => `- ${file}`).join("\n")}\n`,
    );
  }
  if (!args.check && stateOutput) {
    process.stdout.write(`wrote sanitized maturity docs state:\n- ${stateOutput}\n`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
