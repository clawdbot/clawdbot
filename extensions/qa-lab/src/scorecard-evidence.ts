// Qa Lab plugin module embeds profile scorecard context into QA evidence.
import fs from "node:fs/promises";
import {
  attachQaEvidenceScorecard,
  validateQaEvidenceSummaryJson,
  type QaEvidenceScorecardJson,
  type QaEvidenceSummaryEntry,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";
import type {
  QaScorecardCategoryCoverageReport,
  QaScorecardEvidenceMode,
} from "./scorecard-taxonomy.js";

type QaProfileScorecardFilters = {
  surface?: string;
  category?: string;
};

type EvidenceCoverageRole = QaEvidenceSummaryEntry["coverage"][number]["role"];

function uniqueSortedStrings(values: Iterable<string | undefined>) {
  return [
    ...new Set([...values].map((value) => value?.trim()).filter(Boolean) as string[]),
  ].toSorted((left, right) => left.localeCompare(right));
}

function percent(part: number, total: number) {
  return total === 0 ? 0 : Number(((part / total) * 100).toFixed(1));
}

function nullableFilter(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function coverageIdsForRole(
  entries: readonly QaEvidenceSummaryEntry[],
  role: EvidenceCoverageRole,
) {
  return new Set(
    entries.flatMap((entry) =>
      entry.coverage.filter((coverage) => coverage.role === role).map((coverage) => coverage.id),
    ),
  );
}

function statusForCategory(params: { coverageIdCount: number; fulfilledCoverageIdCount: number }) {
  if (params.fulfilledCoverageIdCount === 0) {
    return "missing" as const;
  }
  if (params.fulfilledCoverageIdCount === params.coverageIdCount) {
    return "fulfilled" as const;
  }
  return "partial" as const;
}

function featureCounts(
  features: readonly { coverageIds: readonly string[] }[],
  primaryCoverageIds: ReadonlySet<string>,
) {
  let fulfilled = 0;
  let partial = 0;
  let missing = 0;
  for (const feature of features) {
    const coverageIds = uniqueSortedStrings(feature.coverageIds);
    const fulfilledCoverageIds = coverageIds.filter((coverageId) =>
      primaryCoverageIds.has(coverageId),
    ).length;
    if (coverageIds.length > 0 && fulfilledCoverageIds === coverageIds.length) {
      fulfilled += 1;
    } else if (fulfilledCoverageIds > 0) {
      partial += 1;
    } else {
      missing += 1;
    }
  }
  return {
    total: features.length,
    fulfilled,
    partial,
    missing,
    fulfillmentPercent: percent(fulfilled, features.length),
  };
}

function buildQaProfileScorecardEvidence(params: {
  evidence: QaEvidenceSummaryJson;
  filters: QaProfileScorecardFilters;
  categories: readonly QaScorecardCategoryCoverageReport[];
}): QaEvidenceScorecardJson {
  // Only passing primary evidence fulfills coverage; secondary evidence remains diagnostic.
  const passingEntries = params.evidence.entries.filter((entry) => entry.result.status === "pass");
  const primaryCoverageIds = coverageIdsForRole(passingEntries, "primary");
  const secondaryCoverageIds = coverageIdsForRole(params.evidence.entries, "secondary");
  const categoryInputs = params.categories.map((category) => ({
    category,
    features: category.features,
    coverageIds: uniqueSortedStrings(category.coverageIds),
  }));
  const categoryReports = categoryInputs.map(({ category, features, coverageIds }) => {
    const fulfilledCoverageIdCount = coverageIds.filter((coverageId) =>
      primaryCoverageIds.has(coverageId),
    ).length;
    const secondaryOnlyCoverageIdCount = coverageIds.filter(
      (coverageId) => !primaryCoverageIds.has(coverageId) && secondaryCoverageIds.has(coverageId),
    ).length;
    const missingCoverageIds = uniqueSortedStrings(
      coverageIds.filter((coverageId) => !primaryCoverageIds.has(coverageId)),
    );
    const missingCoverageIdCount = coverageIds.length - fulfilledCoverageIdCount;
    return {
      id: category.id,
      surfaceId: category.taxonomySurfaceId,
      name: category.taxonomyCategoryName,
      status: statusForCategory({
        coverageIdCount: coverageIds.length,
        fulfilledCoverageIdCount,
      }),
      features: featureCounts(features, primaryCoverageIds),
      coverageIds: {
        total: coverageIds.length,
        fulfilled: fulfilledCoverageIdCount,
        secondaryOnly: secondaryOnlyCoverageIdCount,
        missing: missingCoverageIdCount,
        fulfillmentPercent: percent(fulfilledCoverageIdCount, coverageIds.length),
      },
      missingCoverageIds,
    };
  });
  const profileCoverageIds = uniqueSortedStrings(
    categoryInputs.flatMap((input) => input.coverageIds),
  );
  const coverageIdCount = profileCoverageIds.length;
  const fulfilledCoverageIdCount = profileCoverageIds.filter((coverageId) =>
    primaryCoverageIds.has(coverageId),
  ).length;
  const missingCoverageIdCount = coverageIdCount - fulfilledCoverageIdCount;
  const fulfilledCategoryCount = categoryReports.filter(
    (category) => category.status === "fulfilled",
  ).length;
  const partialCategoryCount = categoryReports.filter(
    (category) => category.status === "partial",
  ).length;
  const missingCategoryCount = categoryReports.filter(
    (category) => category.status === "missing",
  ).length;
  const profileFeatures = categoryInputs.flatMap((input) => input.features);
  return {
    filters: {
      surface: nullableFilter(params.filters.surface),
      category: nullableFilter(params.filters.category),
    },
    run: {
      evidenceEntryCount: params.evidence.entries.length,
    },
    categories: {
      total: categoryReports.length,
      fulfilled: fulfilledCategoryCount,
      partial: partialCategoryCount,
      missing: missingCategoryCount,
      fulfillmentPercent: percent(fulfilledCategoryCount, categoryReports.length),
    },
    features: featureCounts(profileFeatures, primaryCoverageIds),
    coverageIds: {
      total: coverageIdCount,
      fulfilled: fulfilledCoverageIdCount,
      missing: missingCoverageIdCount,
      fulfillmentPercent: percent(fulfilledCoverageIdCount, coverageIdCount),
    },
    categoryReports,
  };
}

export async function attachQaProfileScorecardEvidenceToFile(params: {
  evidencePath: string;
  evidenceMode?: QaScorecardEvidenceMode;
  profile: string;
  filters: QaProfileScorecardFilters;
  categories: readonly QaScorecardCategoryCoverageReport[];
}) {
  const evidence = validateQaEvidenceSummaryJson(
    JSON.parse(await fs.readFile(params.evidencePath, "utf8")),
  );
  const scorecard = buildQaProfileScorecardEvidence({
    evidence,
    filters: params.filters,
    categories: params.categories,
  });
  const nextEvidence = attachQaEvidenceScorecard({
    summary: evidence,
    evidenceMode: params.evidenceMode,
    profile: params.profile,
    scorecard,
  });
  await fs.writeFile(params.evidencePath, `${JSON.stringify(nextEvidence, null, 2)}\n`, "utf8");
  return scorecard;
}
