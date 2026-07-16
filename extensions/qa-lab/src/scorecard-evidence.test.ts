// Qa Lab tests cover profile scorecard evidence math.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { QaEvidenceSummaryJson, QaEvidenceSummaryEntry } from "./evidence-summary.js";
import { attachQaProfileScorecardEvidenceToFile } from "./scorecard-evidence.js";
import type { QaScorecardCategoryCoverageReport } from "./scorecard-taxonomy.js";

function evidenceEntry(coverage: QaEvidenceSummaryEntry["coverage"]): QaEvidenceSummaryEntry {
  return {
    test: {
      kind: "flow",
      id: "partial-coverage",
      title: "Partial coverage",
    },
    coverage,
    refs: [],
    result: {
      status: "pass",
    },
  };
}

function evidenceSummary(entries: QaEvidenceSummaryEntry[]): QaEvidenceSummaryJson {
  return {
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt: "2026-06-24T00:00:00.000Z",
    evidenceMode: "full",
    entries,
  };
}

async function buildQaProfileScorecardEvidence(params: {
  evidence: QaEvidenceSummaryJson;
  filters: { surface?: string; category?: string };
  categories: readonly QaScorecardCategoryCoverageReport[];
}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-scorecard-evidence-"));
  const evidencePath = path.join(tempRoot, "qa-evidence-summary.json");
  await fs.writeFile(evidencePath, `${JSON.stringify(params.evidence)}\n`, "utf8");
  try {
    return await attachQaProfileScorecardEvidenceToFile({
      evidencePath,
      profile: "release",
      filters: params.filters,
      categories: params.categories,
    });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

describe("profile scorecard evidence", () => {
  it("scores partial multi-id feature coverage by covered coverage IDs", async () => {
    const category: QaScorecardCategoryCoverageReport = {
      id: "surface.category",
      taxonomySurfaceId: "surface",
      taxonomyCategoryName: "Category",
      coverageStatus: "partial",
      profiles: ["release"],
      features: [{ name: "Multi-id feature", coverageIds: ["coverage.one", "coverage.two"] }],
      coverageIds: ["coverage.one", "coverage.two"],
      fulfilledCoverageIds: ["coverage.one"],
      evidence: [],
      scenarioRefs: [],
      missingCoverageIds: ["coverage.two"],
      missingEvidenceRefs: [],
    };

    const scorecard = await buildQaProfileScorecardEvidence({
      evidence: evidenceSummary([
        evidenceEntry([
          {
            id: "coverage.one",
            role: "primary",
          },
          {
            id: "coverage.two",
            role: "secondary",
          },
        ]),
      ]),
      filters: {},
      categories: [category],
    });

    expect(scorecard.categoryReports[0]?.status).toBe("partial");
    expect(scorecard.categoryReports[0]?.features).toMatchObject({
      total: 1,
      fulfilled: 0,
      partial: 1,
      missing: 0,
      fulfillmentPercent: 0,
    });
    expect(scorecard.categoryReports[0]?.coverageIds).toMatchObject({
      total: 2,
      fulfilled: 1,
      secondaryOnly: 1,
      missing: 1,
      fulfillmentPercent: 50,
    });
    expect(scorecard.coverageIds).toMatchObject({
      total: 2,
      fulfilled: 1,
      missing: 1,
      fulfillmentPercent: 50,
    });
    expect(scorecard.features).toMatchObject({
      total: 1,
      fulfilled: 0,
      partial: 1,
      missing: 0,
      fulfillmentPercent: 0,
    });
  });

  it("counts each profile coverage ID once in global totals", async () => {
    const firstCategory: QaScorecardCategoryCoverageReport = {
      id: "surface.first",
      taxonomySurfaceId: "surface",
      taxonomyCategoryName: "First",
      coverageStatus: "partial",
      profiles: ["release"],
      features: [
        { name: "Shared", coverageIds: ["coverage.shared"] },
        { name: "Unique", coverageIds: ["coverage.unique"] },
      ],
      coverageIds: ["coverage.shared", "coverage.unique"],
      fulfilledCoverageIds: ["coverage.shared"],
      evidence: [],
      scenarioRefs: [],
      missingCoverageIds: ["coverage.unique"],
      missingEvidenceRefs: [],
    };
    const secondCategory: QaScorecardCategoryCoverageReport = {
      ...firstCategory,
      id: "surface.second",
      taxonomyCategoryName: "Second",
      features: [{ name: "Shared again", coverageIds: ["coverage.shared"] }],
      coverageIds: ["coverage.shared"],
      missingCoverageIds: [],
    };

    const scorecard = await buildQaProfileScorecardEvidence({
      evidence: evidenceSummary([
        evidenceEntry([
          {
            id: "coverage.shared",
            role: "primary",
          },
        ]),
      ]),
      filters: {},
      categories: [firstCategory, secondCategory],
    });

    expect(scorecard.categoryReports.map((category) => category.coverageIds.total)).toStrictEqual([
      2, 1,
    ]);
    expect(scorecard.coverageIds).toMatchObject({
      total: 2,
      fulfilled: 1,
      missing: 1,
      fulfillmentPercent: 50,
    });
    expect(scorecard.features).toMatchObject({
      total: 3,
      fulfilled: 2,
      partial: 0,
      missing: 1,
      fulfillmentPercent: 66.7,
    });
  });
});
