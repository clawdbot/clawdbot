import { spawnSync } from "node:child_process";
// Maturity docs renderer tests cover evidence-backed generated-doc checks.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(__dirname, "../..");
const tempDirs = createTempDirTracker();
const generatedLocales = [
  "zh-CN",
  "zh-TW",
  "ja-JP",
  "es",
  "pt-BR",
  "ko",
  "de",
  "fr",
  "hi",
  "ar",
  "it",
  "vi",
  "nl",
  "fa",
  "tr",
  "uk",
  "id",
  "pl",
  "th",
  "ru",
] as const;

type TaxonomyFixture = {
  surfaces?: TaxonomySurfaceFixture[];
};

type TaxonomySurfaceFixture = {
  id?: string;
  status?: string;
  categories?: TaxonomyCategoryFixture[];
};

type TaxonomyCategoryFixture = {
  id?: string;
  name?: string;
  features?: TaxonomyFeatureFixture[];
};

type TaxonomyFeatureFixture = {
  coverageIds?: string[];
};

type MaturityScoresFixture = {
  rollups?: {
    surface_average?: {
      quality?: { score?: number };
      completeness?: { score?: number };
    };
  };
};

afterEach(() => {
  tempDirs.cleanup();
});

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/qa/render-maturity-docs.ts", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

function writeQaEvidence(params: {
  dir: string;
  entries: Array<{ id: string; status: "pass" | "fail" | "blocked" | "skipped" }>;
  scorecard?: unknown;
}) {
  const scorecard = params.scorecard ?? {
    filters: { surface: null, category: null },
    run: { evidenceEntryCount: params.entries.length },
    categories: {
      total: 0,
      fulfilled: 0,
      partial: 0,
      missing: 0,
      fulfillmentPercent: 0,
    },
    features: {
      total: 0,
      fulfilled: 0,
      partial: 0,
      missing: 0,
      fulfillmentPercent: 0,
    },
    coverageIds: {
      total: 0,
      fulfilled: 0,
      missing: 0,
      fulfillmentPercent: 0,
    },
    categoryReports: [],
  };
  fs.mkdirSync(params.dir, { recursive: true });
  fs.writeFileSync(
    path.join(params.dir, "qa-evidence.json"),
    `${JSON.stringify(
      {
        kind: "openclaw.qa.evidence-summary",
        schemaVersion: 2,
        generatedAt: "2026-06-23T00:00:00.000Z",
        evidenceMode: "full",
        profile: "all",
        entries: params.entries.map((entry) => ({
          test: {
            kind: "qa-scenario",
            id: entry.id,
            title: entry.id,
            source: { path: `qa/scenarios/${entry.id}.yaml` },
          },
          coverage: [{ id: "tools.evidence", role: "primary" }],
          result: { status: entry.status },
        })),
        scorecard,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function allProfileScorecardFixture() {
  const taxonomy = parseYaml(
    fs.readFileSync(path.join(repoRoot, "taxonomy.yaml"), "utf8"),
  ) as TaxonomyFixture;
  const activeSurfaces = (taxonomy.surfaces ?? []).filter(
    (surface) => surface.status !== "retired",
  );
  const categoryReports = activeSurfaces.flatMap((surface) =>
    (surface.categories ?? []).map((category) => {
      const coverageIds = [
        ...new Set((category.features ?? []).flatMap((feature) => feature.coverageIds ?? [])),
      ].toSorted();
      const features = category.features ?? [];
      return {
        id: `${surface.id}.${category.id}`,
        surfaceId: surface.id,
        name: category.name,
        status: "missing",
        features: {
          total: features.length,
          fulfilled: 0,
          partial: 0,
          missing: features.length,
          fulfillmentPercent: 0,
        },
        coverageIds: {
          total: coverageIds.length,
          fulfilled: 0,
          missing: coverageIds.length,
          fulfillmentPercent: 0,
          secondaryOnly: 0,
        },
        missingCoverageIds: coverageIds,
      };
    }),
  );
  const featureCount = categoryReports.reduce((count, report) => count + report.features.total, 0);
  const coverageIdCount = categoryReports.reduce(
    (count, report) => count + report.coverageIds.total,
    0,
  );
  return {
    filters: { surface: null, category: null },
    run: { evidenceEntryCount: 1 },
    categories: {
      total: categoryReports.length,
      fulfilled: 0,
      partial: 0,
      missing: categoryReports.length,
      fulfillmentPercent: 0,
    },
    features: {
      total: featureCount,
      fulfilled: 0,
      partial: 0,
      missing: featureCount,
      fulfillmentPercent: 0,
    },
    coverageIds: {
      total: coverageIdCount,
      fulfilled: 0,
      missing: coverageIdCount,
      fulfillmentPercent: 0,
    },
    categoryReports,
  };
}

function expectedMaturityScorePercent(): number {
  const scores = parseYaml(
    fs.readFileSync(path.join(repoRoot, "qa/maturity-scores.yaml"), "utf8"),
  ) as MaturityScoresFixture;
  const quality = scores.rollups?.surface_average?.quality?.score;
  const completeness = scores.rollups?.surface_average?.completeness?.score;
  if (
    typeof quality !== "number" ||
    !Number.isFinite(quality) ||
    typeof completeness !== "number" ||
    !Number.isFinite(completeness)
  ) {
    throw new Error("maturity score fixture is missing surface rollup scores");
  }
  return Math.round((quality + completeness) / 2);
}

describe("maturity docs renderer CLI", () => {
  it("checks maturity inputs without requiring QA evidence artifacts", () => {
    const result = runCli("--check");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("maturity docs inputs and sanitized state are valid");
  });

  it("renders generated docs from the committed sanitized state", () => {
    const outputDir = tempDirs.make("openclaw-maturity-docs-test-");
    const result = runCli("--output-dir", outputDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(fs.readFileSync(path.join(outputDir, "maturity", "scorecard.md"), "utf8")).toContain(
      "## QA evidence summary",
    );
    expect(fs.readFileSync(path.join(outputDir, "maturity", "taxonomy.md"), "utf8")).toContain(
      "# Maturity taxonomy",
    );
  });

  it("requires an explicit state file when the default projection is unavailable", () => {
    const outputDir = tempDirs.make("openclaw-maturity-docs-test-");
    const missingState = path.join(outputDir, "missing-state.json");
    const result = runCli("--output-dir", outputDir, "--state", missingState);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`maturity docs state is missing at ${missingState}`);
  });

  it("rejects extra fields in sanitized state", () => {
    const outputDir = tempDirs.make("openclaw-maturity-docs-test-");
    const statePath = path.join(outputDir, "state.json");
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({ summaries: [], unexpected: true, version: 1 }, null, 2)}\n`,
      "utf8",
    );
    const result = runCli("--output-dir", outputDir, "--state", statePath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must contain exactly: summaries, version");
  });

  it("rejects scorecard evidence with failed or blocked entries", () => {
    const outputDir = tempDirs.make("openclaw-maturity-docs-output-");
    const evidenceDir = tempDirs.make("openclaw-maturity-docs-evidence-");
    writeQaEvidence({
      dir: evidenceDir,
      entries: [
        { id: "passing-scenario", status: "pass" },
        { id: "failing-scenario", status: "fail" },
        { id: "blocked-scenario", status: "blocked" },
      ],
    });

    const result = runCli("--output-dir", outputDir, "--evidence-dir", evidenceDir);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("maturity docs require passing QA evidence");
    expect(result.stderr).toContain("failing-scenario (fail)");
    expect(result.stderr).toContain("blocked-scenario (blocked)");
  });

  it("renders passing evidence without impossible failed or blocked result counts", () => {
    const outputDir = tempDirs.make("openclaw-maturity-docs-output-");
    const evidenceDir = tempDirs.make("openclaw-maturity-docs-evidence-");
    writeQaEvidence({
      dir: evidenceDir,
      entries: [
        { id: "passing-scenario", status: "pass" },
        { id: "skipped-scenario", status: "skipped" },
      ],
      scorecard: allProfileScorecardFixture(),
    });

    const result = runCli("--output-dir", outputDir, "--evidence-dir", evidenceDir);

    expect(result.status).toBe(0);
    const scorecard = fs.readFileSync(path.join(outputDir, "maturity", "scorecard.md"), "utf8");
    const taxonomy = fs.readFileSync(path.join(outputDir, "maturity", "taxonomy.md"), "utf8");
    expect(scorecard).toContain("1 passed, 1 skipped");
    expect(scorecard).not.toContain("0 failed");
    expect(scorecard).not.toContain("0 blocked");
    expect(taxonomy).toMatch(
      /<div className="maturity-category-docs">\n\n {4}\[[^\n]+\]\([^)]+\)[^\n]*\n\n {4}<\/div>/,
    );
    expect(taxonomy).not.toMatch(
      /<div className="maturity-category-docs">[^\n]*\[[^\n]+\]\([^)]+\)[^\n]*<\/div>/,
    );
  });

  it("renders the maturity score from quality and completeness without coverage", () => {
    const outputDir = tempDirs.make("openclaw-maturity-docs-output-");
    const evidenceDir = tempDirs.make("openclaw-maturity-docs-evidence-");
    writeQaEvidence({
      dir: evidenceDir,
      entries: [{ id: "passing-scenario", status: "pass" }],
      scorecard: allProfileScorecardFixture(),
    });

    const result = runCli("--output-dir", outputDir, "--evidence-dir", evidenceDir);

    expect(result.status).toBe(0);
    const scorecard = fs.readFileSync(path.join(outputDir, "maturity", "scorecard.md"), "utf8");
    expect(scorecard).toContain("<span>Maturity score</span>");
    expect(scorecard).toContain(
      `<span className="maturity-summary-value">${expectedMaturityScorePercent()}%</span>`,
    );
    expect(scorecard).toContain("Coverage Experimental - 0%");
    expect(scorecard).toContain("end-to-end coverage above 90%");
  });

  it("renders raw evidence through the same deterministic sanitized projection", () => {
    const evidenceDir = tempDirs.make("openclaw-maturity-docs-evidence-");
    const rawOutputDir = tempDirs.make("openclaw-maturity-docs-raw-");
    const stateOutputDir = tempDirs.make("openclaw-maturity-docs-state-");
    const replayOutputDir = tempDirs.make("openclaw-maturity-docs-replay-");
    const statePath = path.join(stateOutputDir, "maturity-docs-state.json");
    writeQaEvidence({
      dir: evidenceDir,
      entries: [{ id: "passing-scenario", status: "pass" }],
      scorecard: allProfileScorecardFixture(),
    });

    const rawResult = runCli(
      "--output-dir",
      rawOutputDir,
      "--evidence-dir",
      evidenceDir,
      "--state-output",
      statePath,
    );
    expect(rawResult.status).toBe(0);
    expect(rawResult.stderr).toBe("");

    const projection = fs.readFileSync(statePath, "utf8");
    expect(projection).not.toContain("passing-scenario");
    expect(projection).not.toContain("qa/scenarios");
    const parsed = JSON.parse(projection) as {
      summaries: Array<{ categories: unknown[] }>;
    };
    expect(parsed.summaries[0]?.categories).toHaveLength(
      allProfileScorecardFixture().categoryReports.length,
    );
    expect(projection.split("\n").filter((line) => /^        \[/.test(line))).toHaveLength(
      allProfileScorecardFixture().categoryReports.length,
    );

    const replayResult = runCli("--output-dir", replayOutputDir, "--state", statePath);
    expect(replayResult.status).toBe(0);
    for (const fileName of ["scorecard.md", "taxonomy.md"]) {
      expect(fs.readFileSync(path.join(replayOutputDir, "maturity", fileName), "utf8")).toBe(
        fs.readFileSync(path.join(rawOutputDir, "maturity", fileName), "utf8"),
      );
    }
  });

  it("does not replace an existing state projection when evidence is rejected", () => {
    const outputDir = tempDirs.make("openclaw-maturity-docs-output-");
    const evidenceDir = tempDirs.make("openclaw-maturity-docs-evidence-");
    const statePath = path.join(outputDir, "state.json");
    fs.writeFileSync(statePath, "existing-state\n", "utf8");
    writeQaEvidence({
      dir: evidenceDir,
      entries: [{ id: "failing-scenario", status: "fail" }],
    });

    const result = runCli(
      "--output-dir",
      outputDir,
      "--evidence-dir",
      evidenceDir,
      "--state-output",
      statePath,
    );

    expect(result.status).toBe(1);
    expect(fs.readFileSync(statePath, "utf8")).toBe("existing-state\n");
  });

  it("leaves every generated locale byte-identical", () => {
    const outputDir = tempDirs.make("openclaw-maturity-docs-locales-");
    const fixtures = generatedLocales.flatMap((locale) =>
      ["scorecard.md", "taxonomy.md"].map((fileName) => {
        const filePath = path.join(outputDir, locale, "maturity", fileName);
        const content = `${locale}/${fileName}\n`;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf8");
        return [filePath, content] as const;
      }),
    );

    const result = runCli("--output-dir", outputDir);

    expect(result.status).toBe(0);
    expect(generatedLocales).toHaveLength(20);
    for (const [filePath, content] of fixtures) {
      expect(fs.readFileSync(filePath, "utf8")).toBe(content);
    }
  });
});
