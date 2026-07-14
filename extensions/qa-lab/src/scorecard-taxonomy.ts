// Qa Lab plugin module validates taxonomy-backed QA scorecard evidence.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { resolveQaRepoPath, type QaRepoPathKind } from "./repo-path.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";

const QA_MATURITY_TAXONOMY_PATH = "taxonomy.yaml";
const QA_MATURITY_SCORES_PATH = "qa/maturity-scores.yaml";
const QA_MATURITY_SCORE_KEYS = ["quality", "completeness"] as const;
const QA_MATURITY_SCORE_LABELS = ["Clawesome", "Stable", "Beta", "Alpha", "Experimental"] as const;
export const QA_MATURITY_SCORE_LABEL_BANDS = [
  [QA_MATURITY_SCORE_LABELS[0], 95, 100],
  [QA_MATURITY_SCORE_LABELS[1], 80, 95],
  [QA_MATURITY_SCORE_LABELS[2], 70, 80],
  [QA_MATURITY_SCORE_LABELS[3], 50, 70],
  [QA_MATURITY_SCORE_LABELS[4], 0, 50],
] as const;

const qaScorecardIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, {
    message: "scorecard ids must use lowercase dotted or dashed tokens",
  });

const qaCoverageIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/, {
    message: "coverage ids must use lowercase dotted tokens",
  });

function isRepoRootRelativeRef(value: string) {
  return !path.isAbsolute(value) && value.split(/[\\/]+/u).every((part) => part !== "..");
}

const qaCoverageEvidenceRoleSchema = z.enum(["primary", "secondary"]);
export const qaScorecardEvidenceModeSchema = z.enum(["full", "slim"]);
export const qaScorecardChannelDriverSchema = z.enum(["qa-channel", "crabline", "live"]);

const qaScorecardProfileSchema = z.object({
  id: qaScorecardIdSchema,
  description: z.string().trim().min(1),
  evidenceMode: qaScorecardEvidenceModeSchema.optional(),
  includeAllCategories: z.boolean().default(false),
  channelDriver: qaScorecardChannelDriverSchema.default("qa-channel"),
  categoryIds: z.array(qaScorecardIdSchema).default([]),
});

function maturityScoreLabelForScore(score: number) {
  for (const [label, low, high] of QA_MATURITY_SCORE_LABEL_BANDS) {
    if (score >= low && score <= high) {
      return label;
    }
  }
  throw new Error(`score outside 0-100: ${score}`);
}

const qaMaturityScoreObjectSchema = z
  .object({
    score: z.number().int().min(0).max(100),
    label: z.enum(QA_MATURITY_SCORE_LABELS),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expectedLabel = maturityScoreLabelForScore(value.score);
    if (value.label !== expectedLabel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["label"],
        message: `must be ${expectedLabel} for score ${value.score}`,
      });
    }
  });

export function qaMaturityScoreObjectForScore(score: number): QaMaturityScoreObject {
  return qaMaturityScoreObjectSchema.parse({
    score,
    label: maturityScoreLabelForScore(score),
  });
}

const qaMaturityScoreBundleShape = {
  quality: qaMaturityScoreObjectSchema,
  completeness: qaMaturityScoreObjectSchema,
} satisfies z.ZodRawShape;

const qaMaturityLegacyCoverageShape = {
  coverage: qaMaturityScoreObjectSchema.optional(),
} satisfies z.ZodRawShape;

const qaMaturityScoreBundleSchema = z
  .object({
    ...qaMaturityLegacyCoverageShape,
    ...qaMaturityScoreBundleShape,
  })
  .strict();

const qaMaturityScoreLastRunSchema = z
  .object({
    status: z.string().trim().min(1).optional(),
    completed_at: z.string().trim().min(1).optional(),
    by: z.string().trim().min(1).optional(),
    source_ref: z.string().trim().min(1).nullable().optional(),
    process_version: z.number().int().positive().optional(),
  })
  .strict();

const qaMaturityScoreCategoryLtsSchema = z
  .object({
    supported: z.boolean(),
    reason: z.string().trim().min(1).optional(),
    human_override: z.boolean(),
  })
  .strict();

const qaMaturityScoreSurfaceLtsSchema = z
  .object({
    supported_categories: z.number().int().nonnegative(),
    total_categories: z.number().int().nonnegative(),
    status: z.string().trim().min(1),
  })
  .strict();

const qaMaturityScoreCategorySchema = z
  .object({
    name: z.string().trim().min(1),
    ...qaMaturityLegacyCoverageShape,
    ...qaMaturityScoreBundleShape,
    lts: qaMaturityScoreCategoryLtsSchema,
  })
  .strict();

const qaMaturityScoreSurfaceSchema = z
  .object({
    id: qaScorecardIdSchema,
    name: z.string().trim().min(1),
    family: z.string().trim().min(1).optional(),
    level: z.union([
      z.string().trim().min(1),
      z
        .object({
          id: z.string().trim().min(1).optional(),
          code: z.string().trim().min(1).optional(),
          label: z.string().trim().min(1).optional(),
        })
        .strict(),
    ]),
    scores: qaMaturityScoreBundleSchema,
    categories: z.array(qaMaturityScoreCategorySchema),
    lts: qaMaturityScoreSurfaceLtsSchema,
    last_score_run: qaMaturityScoreLastRunSchema.optional(),
  })
  .strict();

const qaMaturityScoresSchema = z
  .object({
    version: z.literal(1),
    process_version: z.number().int().positive(),
    counts: z
      .object({
        active_surfaces: z.number().int().nonnegative(),
        category_scores: z.number().int().nonnegative(),
      })
      .strict(),
    rollups: z
      .object({
        surface_average: qaMaturityScoreBundleSchema,
        category_average: qaMaturityScoreBundleSchema,
      })
      .strict(),
    surfaces: z.array(qaMaturityScoreSurfaceSchema),
  })
  .strict();

const qaMaturityFeatureSchema = z.object({
  name: z.string().trim().min(1),
  coverageIds: z.array(qaCoverageIdSchema).default([]),
  description: z.string().trim().min(1).optional(),
});

const qaMaturityCategorySchema = z.object({
  id: qaScorecardIdSchema,
  name: z.string().trim().min(1),
  category_note: z.string().trim().min(1),
  features: z.array(qaMaturityFeatureSchema).default([]),
  docs: z.array(z.string().trim().min(1)).default([]),
  search_anchors: z.array(z.string().trim().min(1)).default([]),
  human_lts_override: z.boolean().optional(),
});

const qaMaturitySurfaceSchema = z.object({
  id: qaScorecardIdSchema,
  name: z.string().trim().min(1),
  family: z.string().trim().min(1),
  level: z.string().trim().min(1),
  level_code: z.string().trim().min(1).optional(),
  archived: z.boolean().optional(),
  rationale: z.string().trim().min(1).optional(),
  completeness_instructions: z.string().trim().min(1).optional(),
  last_score_run: qaMaturityScoreLastRunSchema.optional(),
  categories: z.array(qaMaturityCategorySchema).default([]),
});

const qaMaturityLevelSchema = z.object({
  id: z.string().trim().min(1),
  code: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).optional(),
  meaning: z.string().trim().min(1).optional(),
  promotion_bar: z.string().trim().min(1).optional(),
});

const qaMaturityTaxonomySchema = z
  .object({
    version: z.literal(1),
    process_version: z.number().int().positive().optional(),
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1).optional(),
    snapshot: z
      .object({
        date: z.string().trim().min(1).optional(),
        source_ref: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    profiles: z.array(qaScorecardProfileSchema).default([]),
    levels: z.array(qaMaturityLevelSchema).default([]),
    surfaces: z.array(qaMaturitySurfaceSchema).default([]),
  })
  .superRefine((taxonomy, ctx) => {
    const seenProfileIds = new Set<string>();
    for (const [profileIndex, profile] of taxonomy.profiles.entries()) {
      if (seenProfileIds.has(profile.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", profileIndex, "id"],
          message: `duplicate scorecard profile id: ${profile.id}`,
        });
      }
      seenProfileIds.add(profile.id);

      if (profile.includeAllCategories && profile.categoryIds.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", profileIndex, "categoryIds"],
          message: `profile ${profile.id} cannot set categoryIds when includeAllCategories is true`,
        });
      }
      if (profile.channelDriver === "crabline" && profile.includeAllCategories) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", profileIndex, "includeAllCategories"],
          message: `profile ${profile.id} cannot set includeAllCategories when channelDriver is crabline`,
        });
      }
      if (profile.channelDriver === "crabline" && !profile.categoryIds.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", profileIndex, "categoryIds"],
          message: `profile ${profile.id} requires categoryIds when channelDriver is crabline`,
        });
      }

      const seenProfileCategoryIds = new Set<string>();
      for (const [categoryIndex, categoryId] of profile.categoryIds.entries()) {
        if (seenProfileCategoryIds.has(categoryId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["profiles", profileIndex, "categoryIds", categoryIndex],
            message: `duplicate category id in profile ${profile.id}: ${categoryId}`,
          });
        }
        seenProfileCategoryIds.add(categoryId);
      }
    }

    const categoryIds = new Set<string>();
    const surfaceIds = new Set<string>();
    for (const [surfaceIndex, surface] of taxonomy.surfaces.entries()) {
      if (surfaceIds.has(surface.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["surfaces", surfaceIndex, "id"],
          message: `duplicate surface id: ${surface.id}`,
        });
      }
      surfaceIds.add(surface.id);

      const localCategoryIds = new Set<string>();
      for (const [categoryIndex, category] of surface.categories.entries()) {
        if (localCategoryIds.has(category.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["surfaces", surfaceIndex, "categories", categoryIndex, "id"],
            message: `duplicate category id in surface ${surface.id}: ${category.id}`,
          });
        }
        localCategoryIds.add(category.id);
        categoryIds.add(`${surface.id}.${category.id}`);
      }
    }

    for (const [profileIndex, profile] of taxonomy.profiles.entries()) {
      for (const [categoryIndex, categoryId] of profile.categoryIds.entries()) {
        if (!categoryIds.has(categoryId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["profiles", profileIndex, "categoryIds", categoryIndex],
            message: `profile ${profile.id} references missing category ${categoryId}`,
          });
        }
      }
    }
  });

type QaNativeCoverageEvidenceKind = "script" | "vitest" | "playwright";
type QaScorecardEvidenceKind = QaNativeCoverageEvidenceKind | "qa-scenario";
export type QaScorecardEvidenceMode = z.infer<typeof qaScorecardEvidenceModeSchema>;
export type QaScorecardChannelDriver = z.infer<typeof qaScorecardChannelDriverSchema>;
type QaMaturityScoreKey = (typeof QA_MATURITY_SCORE_KEYS)[number];
export type QaMaturityScoreObject = z.infer<typeof qaMaturityScoreObjectSchema>;
export type QaMaturityScoreSurfaceLts = z.infer<typeof qaMaturityScoreSurfaceLtsSchema>;
type QaMaturityScoreCategory = z.infer<typeof qaMaturityScoreCategorySchema>;
export type QaMaturityScoreSurface = z.infer<typeof qaMaturityScoreSurfaceSchema>;
export type QaMaturityScores = z.infer<typeof qaMaturityScoresSchema>;
export type QaMaturityTaxonomyLevel = z.infer<typeof qaMaturityLevelSchema>;
type QaMaturityTaxonomyCategory = z.infer<typeof qaMaturityCategorySchema>;
export type QaMaturityTaxonomySurface = z.infer<typeof qaMaturitySurfaceSchema>;
export type QaMaturityTaxonomy = z.infer<typeof qaMaturityTaxonomySchema>;
type QaCoverageEvidenceRole = z.infer<typeof qaCoverageEvidenceRoleSchema>;

export type QaMaturityCoverageScores = {
  categories: Map<string, QaMaturityScoreObject>;
};

type QaScorecardValidationIssueCode =
  | "coverage-id-missing-primary-evidence"
  | "coverage-id-not-found"
  | "evidence-ref-not-found"
  | "taxonomy-ref-not-found"
  | "taxonomy-category-ref-not-found"
  | "profile-category-ref-not-found"
  | "profile-category-missing-evidence";

type QaScorecardValidationIssue = {
  code: QaScorecardValidationIssueCode;
  severity: "warning";
  categoryId?: string;
  ref?: string;
  message: string;
};

type QaScorecardEvidenceReport = {
  coverageId: string;
  kind: QaScorecardEvidenceKind;
  path: string | null;
  role: QaCoverageEvidenceRole;
  scenarioRefs: string[];
};

export type QaScorecardCategoryCoverageReport = {
  id: string;
  taxonomySurfaceId: string;
  taxonomyCategoryName: string;
  coverageStatus: "covered" | "partial" | "missing";
  profiles: string[];
  features: QaScorecardCategoryFeatureCoverageReport[];
  coverageIds: string[];
  fulfilledCoverageIds: string[];
  evidence: QaScorecardEvidenceReport[];
  scenarioRefs: string[];
  missingCoverageIds: string[];
  missingEvidenceRefs: string[];
};

type QaScorecardCategoryFeatureCoverageReport = {
  name: string;
  coverageIds: string[];
};

type QaScorecardProfileReport = {
  id: string;
  evidenceMode: QaScorecardEvidenceMode;
  channelDriver: QaScorecardChannelDriver;
  categoryIds: string[];
};

export type QaScorecardTaxonomyReport = {
  taxonomyPath: string | null;
  title: string | null;
  taxonomy: {
    sourcePath: string;
  } | null;
  profileCount: number;
  profiles: QaScorecardProfileReport[];
  categoryCount: number;
  requiredCategoryCount: number;
  fulfilledCategoryCount: number;
  categoryFulfillmentPercent: number;
  requiredCoverageIdCount: number;
  fulfilledCoverageIdCount: number;
  coverageIdFulfillmentPercent: number;
  evidenceRefCount: number;
  scenarioCoverageIdCount: number;
  unknownCoverageIdCount: number;
  unknownCoverageIds: string[];
  validationIssueCount: number;
  validationIssues: QaScorecardValidationIssue[];
  categories: QaScorecardCategoryCoverageReport[];
};

type QaMaturityTaxonomyCategoryIndex = {
  active: QaMaturityTaxonomySurface[];
  surfaces: Map<
    string,
    { surface: QaMaturityTaxonomySurface; categories: Map<string, QaMaturityTaxonomyCategory> }
  >;
};

type MaturityCategoryRef = {
  id: string;
  surfaceId: string;
  categoryName: string;
  features: MaturityFeatureRef[];
  coverageIds: string[];
};

type MaturityFeatureRef = {
  name: string;
  coverageIds: string[];
};

type MaturityCoverageRef = {
  coverageId: string;
  categoryId: string;
  surfaceId: string;
};

function resolveRepoPath(relativePath: string, kind: QaRepoPathKind = "file") {
  return resolveQaRepoPath(import.meta.dirname, relativePath, kind);
}

function repoRootFromPath(filePath: string) {
  return path.dirname(filePath);
}

function formatZodIssuePath(pathLocal: PropertyKey[]) {
  return pathLocal.length ? pathLocal.map(String).join(".") : "<root>";
}

function parseQaMaturityTaxonomy(value: unknown, label = QA_MATURITY_TAXONOMY_PATH) {
  const parsed = qaMaturityTaxonomySchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const issues = parsed.error.issues
    .map((issue) => `${formatZodIssuePath(issue.path)}: ${issue.message}`)
    .join("; ");
  throw new Error(`${label}: ${issues}`);
}

function parseQaMaturityScores(value: unknown, label = QA_MATURITY_SCORES_PATH) {
  const parsed = qaMaturityScoresSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const issues = parsed.error.issues
    .map((issue) => `${formatZodIssuePath(issue.path)}: ${issue.message}`)
    .join("; ");
  throw new Error(`${label}: ${issues}`);
}

export function readQaMaturityTaxonomySource(taxonomyPath = QA_MATURITY_TAXONOMY_PATH) {
  return parseQaMaturityTaxonomy(YAML.parse(fs.readFileSync(taxonomyPath, "utf8")), taxonomyPath);
}

export function readValidatedQaMaturityScoreSources(params?: {
  coverageScores?: QaMaturityCoverageScores;
  scoresPath?: string;
  taxonomy?: QaMaturityTaxonomy;
  taxonomyPath?: string;
}) {
  const taxonomyPath = params?.taxonomyPath ?? QA_MATURITY_TAXONOMY_PATH;
  const scoresPath = params?.scoresPath ?? QA_MATURITY_SCORES_PATH;
  const taxonomy = params?.taxonomy ?? readQaMaturityTaxonomySource(taxonomyPath);
  const scores = parseQaMaturityScores(YAML.parse(fs.readFileSync(scoresPath, "utf8")), scoresPath);
  const warnings = validateQaMaturityScoresAgainstTaxonomy({
    coverageScores: params?.coverageScores,
    scores,
    taxonomy,
    scoresPath,
  });
  return { scores, taxonomy, warnings };
}

function readQaMaturityTaxonomy(repoRoot: string | undefined) {
  const taxonomyPath = repoRoot
    ? path.join(repoRoot, QA_MATURITY_TAXONOMY_PATH)
    : resolveRepoPath(QA_MATURITY_TAXONOMY_PATH);
  if (!taxonomyPath || !fs.existsSync(taxonomyPath)) {
    return null;
  }
  return parseQaMaturityTaxonomy(
    YAML.parse(fs.readFileSync(taxonomyPath, "utf8")) as unknown,
    QA_MATURITY_TAXONOMY_PATH,
  );
}

function pathExists(repoRoot: string | undefined, relativePath: string) {
  if (!isRepoRootRelativeRef(relativePath)) {
    return false;
  }
  return repoRoot ? fs.existsSync(path.join(repoRoot, relativePath)) : true;
}

function scenarioCoverageIds(scenario: QaSeedScenarioWithSource) {
  return [...(scenario.coverage?.primary ?? []), ...(scenario.coverage?.secondary ?? [])];
}

type ScenarioEvidenceRef = {
  sourcePath: string;
  kind: QaScorecardEvidenceKind;
  path: string | null;
};

function scenarioEvidenceKind(scenario: QaSeedScenarioWithSource): QaScorecardEvidenceKind {
  return scenario.execution.kind === "flow" ? "qa-scenario" : scenario.execution.kind;
}

function scenarioEvidencePath(scenario: QaSeedScenarioWithSource) {
  return scenario.execution.kind === "flow" ? null : scenario.execution.path;
}

function collectScenarioEvidenceByCoverageId(params: {
  scenarios: readonly QaSeedScenarioWithSource[];
  role: QaCoverageEvidenceRole;
}) {
  const refsByCoverageId = new Map<string, ScenarioEvidenceRef[]>();
  for (const scenario of params.scenarios) {
    const coverageIds =
      params.role === "primary"
        ? (scenario.coverage?.primary ?? [])
        : (scenario.coverage?.secondary ?? []);
    for (const coverageId of coverageIds) {
      const refs = refsByCoverageId.get(coverageId) ?? [];
      refs.push({
        sourcePath: scenario.sourcePath,
        kind: scenarioEvidenceKind(scenario),
        path: scenarioEvidencePath(scenario),
      });
      refsByCoverageId.set(coverageId, refs);
    }
  }
  return refsByCoverageId;
}

function uniqueSorted(values: Iterable<string>) {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function percent(part: number, total: number) {
  return total === 0 ? 0 : Number(((part / total) * 100).toFixed(1));
}

export function activeQaMaturityTaxonomySurfaces(taxonomy: QaMaturityTaxonomy) {
  return taxonomy.surfaces.filter((surface) => !surface.archived);
}

function buildQaMaturityTaxonomyCategoryIndex(
  taxonomy: QaMaturityTaxonomy,
): QaMaturityTaxonomyCategoryIndex {
  const active = activeQaMaturityTaxonomySurfaces(taxonomy);
  const surfaces = new Map<
    string,
    { surface: QaMaturityTaxonomySurface; categories: Map<string, QaMaturityTaxonomyCategory> }
  >();
  for (const surface of active) {
    const categories = new Map<string, QaMaturityTaxonomyCategory>();
    for (const category of surface.categories) {
      if (categories.has(category.name)) {
        throw new Error(`taxonomy.yaml: ${surface.id}: duplicate category name ${category.name}`);
      }
      categories.set(category.name, category);
    }
    surfaces.set(surface.id, { surface, categories });
  }
  return { active, surfaces };
}

export function qaMaturityTaxonomyLevelMap(taxonomy: QaMaturityTaxonomy) {
  return new Map(taxonomy.levels.map((level) => [level.id, level]));
}

export function qaMaturityFamilyOrder(surfaces: readonly QaMaturityTaxonomySurface[]): string[] {
  const seen: string[] = [];
  for (const surface of surfaces) {
    if (!seen.includes(surface.family)) {
      seen.push(surface.family);
    }
  }
  return seen;
}

function averageSurfaceScore(rows: readonly QaMaturityScoreSurface[], key: QaMaturityScoreKey) {
  return Math.round(rows.reduce((sum, row) => sum + row.scores[key].score, 0) / rows.length);
}

function averageCategoryScore(rows: readonly QaMaturityScoreCategory[], key: QaMaturityScoreKey) {
  return Math.round(rows.reduce((sum, row) => sum + row[key].score, 0) / rows.length);
}

export function qaMaturityCoverageCategoryKey(surfaceId: string, categoryName: string) {
  return `${surfaceId}\u0000${categoryName}`;
}

function expectedMaturityLtsSupported(params: {
  coverage?: QaMaturityScoreObject;
  scoreCategory: QaMaturityScoreCategory;
  taxonomyCategory: QaMaturityTaxonomyCategory;
}) {
  return (
    (params.scoreCategory.quality.score > 80 && (params.coverage?.score ?? -1) > 90) ||
    params.taxonomyCategory.human_lts_override === true
  );
}

function expectedMaturitySurfaceLtsStatus(supportedCategories: number, totalCategories: number) {
  if (supportedCategories === 0) {
    return "none";
  }
  return supportedCategories === totalCategories ? "full" : "partial";
}

function validateQaMaturityScoresAgainstTaxonomy(params: {
  coverageScores?: QaMaturityCoverageScores;
  scores: QaMaturityScores;
  taxonomy: QaMaturityTaxonomy;
  scoresPath?: string;
}) {
  const scoresPath = params.scoresPath ?? QA_MATURITY_SCORES_PATH;
  const warnings: string[] = [];
  const scoreSurfaces = params.scores.surfaces;
  const taxonomyIndex = buildQaMaturityTaxonomyCategoryIndex(params.taxonomy);
  if (params.scores.counts.active_surfaces !== scoreSurfaces.length) {
    throw new Error(
      `${scoresPath}.counts.active_surfaces must match score surface count (${scoreSurfaces.length})`,
    );
  }
  if (params.scores.counts.active_surfaces !== taxonomyIndex.active.length) {
    throw new Error(
      `${scoresPath}.counts.active_surfaces must match active taxonomy surfaces (${taxonomyIndex.active.length})`,
    );
  }

  const taxonomyCategoryCount = taxonomyIndex.active.reduce(
    (count, surface) => count + surface.categories.length,
    0,
  );
  if (params.scores.counts.category_scores !== taxonomyCategoryCount) {
    throw new Error(
      `${scoresPath}.counts.category_scores must match active taxonomy categories (${taxonomyCategoryCount})`,
    );
  }

  const seenSurfaceIds = new Set<string>();
  const allScoreCategories: QaMaturityScoreCategory[] = [];
  for (const scoreSurface of scoreSurfaces) {
    const surfaceId = scoreSurface.id;
    if (seenSurfaceIds.has(surfaceId)) {
      throw new Error(`${scoresPath}: duplicate surface id ${surfaceId}`);
    }
    seenSurfaceIds.add(surfaceId);

    const taxonomySurface = taxonomyIndex.surfaces.get(surfaceId);
    if (!taxonomySurface) {
      throw new Error(`${scoresPath}: surface ${surfaceId} is not an active taxonomy surface`);
    }
    const categories = scoreSurface.categories;
    if (taxonomySurface && categories.length !== taxonomySurface.categories.size) {
      throw new Error(
        `${scoresPath}.${surfaceId}.categories must match taxonomy category count (${taxonomySurface.categories.size})`,
      );
    }

    const seenCategoryNames = new Set<string>();
    let supportedCategories = 0;
    for (const scoreCategory of categories) {
      const categoryName = scoreCategory.name;
      if (seenCategoryNames.has(categoryName)) {
        throw new Error(`${scoresPath}.${surfaceId}: duplicate category name ${categoryName}`);
      }
      seenCategoryNames.add(categoryName);
      const lts = scoreCategory.lts;

      const taxonomyCategory = taxonomySurface?.categories.get(categoryName);
      if (taxonomySurface && !taxonomyCategory) {
        throw new Error(
          `${scoresPath}.${surfaceId}: score category ${categoryName} is not in taxonomy`,
        );
      }
      if (taxonomyCategory) {
        if (lts.human_override !== Boolean(taxonomyCategory.human_lts_override)) {
          throw new Error(
            `${scoresPath}.${surfaceId}.${categoryName}.lts.human_override must match taxonomy human_lts_override`,
          );
        }
        const coverage = params.coverageScores?.categories.get(
          qaMaturityCoverageCategoryKey(surfaceId, categoryName),
        );
        if (coverage || taxonomyCategory.human_lts_override === true) {
          const expectedSupported = expectedMaturityLtsSupported({
            coverage,
            scoreCategory,
            taxonomyCategory,
          });
          if (lts.supported !== expectedSupported) {
            throw new Error(
              `${scoresPath}.${surfaceId}.${categoryName}.lts.supported must match quality, release evidence coverage, or taxonomy human_lts_override`,
            );
          }
        }
      }
      if (lts.supported) {
        supportedCategories += 1;
      }
      allScoreCategories.push(scoreCategory);
    }

    const surfaceLts = scoreSurface.lts;
    if (surfaceLts.supported_categories !== supportedCategories) {
      throw new Error(
        `${scoresPath}.${surfaceId}.lts.supported_categories must equal supported category count (${supportedCategories})`,
      );
    }
    if (surfaceLts.total_categories !== categories.length) {
      throw new Error(
        `${scoresPath}.${surfaceId}.lts.total_categories must equal score category count (${categories.length})`,
      );
    }
    const expectedStatus = expectedMaturitySurfaceLtsStatus(supportedCategories, categories.length);
    if (surfaceLts.status !== expectedStatus) {
      throw new Error(`${scoresPath}.${surfaceId}.lts.status must be ${expectedStatus}`);
    }
  }

  for (const surfaceId of taxonomyIndex.surfaces.keys()) {
    if (!seenSurfaceIds.has(surfaceId)) {
      throw new Error(`${scoresPath}: missing active taxonomy surface ${surfaceId}`);
    }
  }
  if (params.scores.counts.category_scores !== allScoreCategories.length) {
    throw new Error(
      `${scoresPath}.counts.category_scores must match score category count (${allScoreCategories.length})`,
    );
  }

  const rollups = params.scores.rollups;
  for (const key of QA_MATURITY_SCORE_KEYS) {
    const expectedSurfaceAverage = averageSurfaceScore(scoreSurfaces, key);
    if (rollups.surface_average[key].score !== expectedSurfaceAverage) {
      throw new Error(
        `${scoresPath}.rollups.surface_average.${key}.score must be ${expectedSurfaceAverage}`,
      );
    }
    const expectedCategoryAverage = averageCategoryScore(allScoreCategories, key);
    if (rollups.category_average[key].score !== expectedCategoryAverage) {
      throw new Error(
        `${scoresPath}.rollups.category_average.${key}.score must be ${expectedCategoryAverage}`,
      );
    }
  }
  return warnings;
}

function buildMaturityRefs(taxonomy: QaMaturityTaxonomy | null) {
  const categories = new Map<string, MaturityCategoryRef>();
  const coverageIds = new Map<string, MaturityCoverageRef[]>();
  if (!taxonomy) {
    return { categories, coverageIds };
  }

  for (const surface of activeQaMaturityTaxonomySurfaces(taxonomy)) {
    for (const category of surface.categories) {
      const categoryId = `${surface.id}.${category.id}`;
      const features = category.features.map((feature) => ({
        name: feature.name,
        coverageIds: uniqueSorted(feature.coverageIds),
      }));
      const categoryCoverageIds = uniqueSorted(features.flatMap((feature) => feature.coverageIds));
      for (const coverageId of categoryCoverageIds) {
        const refs = coverageIds.get(coverageId) ?? [];
        refs.push({
          coverageId,
          categoryId,
          surfaceId: surface.id,
        });
        coverageIds.set(coverageId, refs);
      }
      categories.set(categoryId, {
        id: categoryId,
        surfaceId: surface.id,
        categoryName: category.name,
        features,
        coverageIds: categoryCoverageIds,
      });
    }
  }
  return { categories, coverageIds };
}

export function readQaScorecardProfileOptions(profileId: string | undefined, repoRoot?: string) {
  const profile = profileId?.trim();
  if (!profile) {
    return { evidenceMode: "full" as const, channelDriver: "qa-channel" as const };
  }
  const profileOptions = readQaMaturityTaxonomy(repoRoot)?.profiles.find(
    (entry) => entry.id === profile,
  );
  return {
    evidenceMode: profileOptions?.evidenceMode ?? "full",
    channelDriver: profileOptions?.channelDriver ?? "qa-channel",
  };
}

function pushMissingPrimaryIssues(params: {
  issues: QaScorecardValidationIssue[];
  category: MaturityCategoryRef;
  coverageIdsWithPrimaryEvidence: ReadonlySet<string>;
  coverageIdsWithSecondaryEvidence: ReadonlySet<string>;
}) {
  for (const feature of params.category.features) {
    for (const coverageId of feature.coverageIds) {
      if (params.coverageIdsWithPrimaryEvidence.has(coverageId)) {
        continue;
      }
      const reason = params.coverageIdsWithSecondaryEvidence.has(coverageId)
        ? "only has secondary evidence"
        : "has no primary evidence";
      params.issues.push({
        code: "coverage-id-missing-primary-evidence",
        severity: "warning",
        categoryId: params.category.id,
        ref: coverageId,
        message: `${params.category.id} feature ${feature.name} coverage ID ${coverageId} ${reason}`,
      });
    }
  }
}

function collectEvidenceReportsForCoverageId(params: {
  coverageId: string;
  role: QaCoverageEvidenceRole;
  refs: readonly ScenarioEvidenceRef[];
  repoRoot?: string;
  categoryId: string;
  issues: QaScorecardValidationIssue[];
  missingEvidenceRefsByCategoryId: Map<string, Set<string>>;
}) {
  const grouped = new Map<string, QaScorecardEvidenceReport>();
  for (const ref of params.refs) {
    if (ref.path && !pathExists(params.repoRoot, ref.path)) {
      const missingRefs =
        params.missingEvidenceRefsByCategoryId.get(params.categoryId) ?? new Set();
      missingRefs.add(ref.path);
      params.missingEvidenceRefsByCategoryId.set(params.categoryId, missingRefs);
      params.issues.push({
        code: "evidence-ref-not-found",
        severity: "warning",
        categoryId: params.categoryId,
        ref: ref.path,
        message: `${params.categoryId} references missing ${ref.kind} evidence ${ref.path}`,
      });
      continue;
    }

    const key = `${ref.kind}\0${ref.path ?? ""}`;
    const report =
      grouped.get(key) ??
      ({
        coverageId: params.coverageId,
        kind: ref.kind,
        path: ref.path,
        role: params.role,
        scenarioRefs: [],
      } satisfies QaScorecardEvidenceReport);
    report.scenarioRefs.push(ref.sourcePath);
    grouped.set(key, report);
  }

  return [...grouped.values()].map((report) => {
    report.scenarioRefs = uniqueSorted(report.scenarioRefs);
    return report;
  });
}

export function buildQaScorecardTaxonomyReport(params: {
  taxonomy: QaMaturityTaxonomy | null;
  taxonomyPath?: string | null;
  repoRoot?: string;
  scenarios: readonly QaSeedScenarioWithSource[];
}): QaScorecardTaxonomyReport {
  const maturityRefs = buildMaturityRefs(params.taxonomy);
  const issues: QaScorecardValidationIssue[] = [];
  const categories: QaScorecardCategoryCoverageReport[] = [];
  const primaryScenarioRefsByCoverageId = collectScenarioEvidenceByCoverageId({
    scenarios: params.scenarios,
    role: "primary",
  });
  const secondaryScenarioRefsByCoverageId = collectScenarioEvidenceByCoverageId({
    scenarios: params.scenarios,
    role: "secondary",
  });
  const allScenarioCoverageIds = uniqueSorted(params.scenarios.flatMap(scenarioCoverageIds));
  const missingEvidenceRefsByCategoryId = new Map<string, Set<string>>();

  if (!pathExists(params.repoRoot, QA_MATURITY_TAXONOMY_PATH) || !params.taxonomy) {
    issues.push({
      code: "taxonomy-ref-not-found",
      severity: "warning",
      ref: QA_MATURITY_TAXONOMY_PATH,
      message: `Scorecard taxonomy not found at ${QA_MATURITY_TAXONOMY_PATH}`,
    });
  }

  for (const coverageId of allScenarioCoverageIds) {
    if (!maturityRefs.coverageIds.has(coverageId)) {
      issues.push({
        code: "coverage-id-not-found",
        severity: "warning",
        ref: coverageId,
        message: `QA scenario references missing taxonomy coverage ID ${coverageId}`,
      });
    }
  }

  const profileCategoryIdsByCategoryId = new Map<string, Set<string>>();
  const profiles =
    params.taxonomy?.profiles.map((profile) => {
      const validCategoryIds: string[] = [];
      const selectedCategoryIds = profile.includeAllCategories
        ? [...maturityRefs.categories.keys()]
        : profile.categoryIds;
      for (const categoryId of selectedCategoryIds) {
        if (!maturityRefs.categories.has(categoryId)) {
          issues.push({
            code: "profile-category-ref-not-found",
            severity: "warning",
            ref: categoryId,
            message: `${profile.id} profile references missing taxonomy category ${categoryId}`,
          });
          continue;
        }
        const profileIds = profileCategoryIdsByCategoryId.get(categoryId) ?? new Set<string>();
        profileIds.add(profile.id);
        profileCategoryIdsByCategoryId.set(categoryId, profileIds);
        validCategoryIds.push(categoryId);
      }
      return {
        id: profile.id,
        evidenceMode: profile.evidenceMode ?? "full",
        channelDriver: profile.channelDriver,
        categoryIds: validCategoryIds,
      };
    }) ?? [];

  const categoryIdsWithEvidence = new Set<string>();
  for (const coverageId of [
    ...primaryScenarioRefsByCoverageId.keys(),
    ...secondaryScenarioRefsByCoverageId.keys(),
  ]) {
    const coverageRefs = maturityRefs.coverageIds.get(coverageId) ?? [];
    for (const coverageRef of coverageRefs) {
      categoryIdsWithEvidence.add(coverageRef.categoryId);
    }
  }
  const relevantCategoryIds = uniqueSorted([
    ...profileCategoryIdsByCategoryId.keys(),
    ...categoryIdsWithEvidence,
  ]);

  const requiredCoverageIds = new Set<string>();
  const fulfilledRequiredCoverageIds = new Set<string>();
  for (const categoryId of relevantCategoryIds) {
    const category = maturityRefs.categories.get(categoryId);
    if (!category) {
      issues.push({
        code: "taxonomy-category-ref-not-found",
        severity: "warning",
        ref: categoryId,
        message: `${categoryId} does not match a maturity taxonomy category`,
      });
      continue;
    }

    const profileIds = uniqueSorted(profileCategoryIdsByCategoryId.get(categoryId) ?? []);
    const required = profileIds.length > 0;
    const evidenceReports: QaScorecardEvidenceReport[] = [];
    const categoryScenarioRefs = new Set<string>();
    const fulfilledCoverageIds = new Set<string>();
    const secondaryOnlyCoverageIds = new Set<string>();
    const coverageIdsWithAnyEvidence = new Set<string>();

    for (const coverageId of category.coverageIds) {
      const primaryScenarioRefs = primaryScenarioRefsByCoverageId.get(coverageId) ?? [];
      const secondaryScenarioRefs = secondaryScenarioRefsByCoverageId.get(coverageId) ?? [];
      const primaryEvidenceReports = collectEvidenceReportsForCoverageId({
        coverageId,
        role: "primary",
        refs: primaryScenarioRefs,
        repoRoot: params.repoRoot,
        categoryId,
        issues,
        missingEvidenceRefsByCategoryId,
      });
      const secondaryEvidenceReports = collectEvidenceReportsForCoverageId({
        coverageId,
        role: "secondary",
        refs: secondaryScenarioRefs,
        repoRoot: params.repoRoot,
        categoryId,
        issues,
        missingEvidenceRefsByCategoryId,
      });

      if (primaryEvidenceReports.length > 0) {
        for (const scenarioRef of primaryEvidenceReports.flatMap((report) => report.scenarioRefs)) {
          categoryScenarioRefs.add(scenarioRef);
        }
        fulfilledCoverageIds.add(coverageId);
        coverageIdsWithAnyEvidence.add(coverageId);
        evidenceReports.push(...primaryEvidenceReports);
      }

      if (secondaryEvidenceReports.length > 0) {
        for (const scenarioRef of secondaryEvidenceReports.flatMap(
          (report) => report.scenarioRefs,
        )) {
          categoryScenarioRefs.add(scenarioRef);
        }
        if (!fulfilledCoverageIds.has(coverageId)) {
          secondaryOnlyCoverageIds.add(coverageId);
        }
        coverageIdsWithAnyEvidence.add(coverageId);
        evidenceReports.push(...secondaryEvidenceReports);
      }
    }

    const fulfilledCoverageIdCountForCategory = category.coverageIds.filter((coverageId) =>
      fulfilledCoverageIds.has(coverageId),
    ).length;
    if (required) {
      for (const coverageId of category.coverageIds) {
        requiredCoverageIds.add(coverageId);
        if (fulfilledCoverageIds.has(coverageId)) {
          fulfilledRequiredCoverageIds.add(coverageId);
        }
      }
      pushMissingPrimaryIssues({
        issues,
        category,
        coverageIdsWithPrimaryEvidence: fulfilledCoverageIds,
        coverageIdsWithSecondaryEvidence: secondaryOnlyCoverageIds,
      });
      if (fulfilledCoverageIdCountForCategory === 0) {
        issues.push({
          code: "profile-category-missing-evidence",
          severity: "warning",
          categoryId,
          message: `${categoryId} is selected by a runnable profile but has no primary coverage evidence`,
        });
      }
    }

    const missingCoverageIds = required
      ? category.coverageIds.filter((coverageId) => !coverageIdsWithAnyEvidence.has(coverageId))
      : [];
    const coverageStatus =
      required &&
      category.coverageIds.length > 0 &&
      fulfilledCoverageIdCountForCategory === category.coverageIds.length
        ? "covered"
        : evidenceReports.length > 0
          ? "partial"
          : "missing";

    categories.push({
      id: category.id,
      taxonomySurfaceId: category.surfaceId,
      taxonomyCategoryName: category.categoryName,
      coverageStatus,
      profiles: profileIds,
      features: category.features,
      coverageIds: category.coverageIds,
      fulfilledCoverageIds: uniqueSorted(fulfilledCoverageIds),
      evidence: evidenceReports.toSorted((left, right) =>
        `${left.coverageId}:${left.kind}:${left.path ?? ""}:${left.role}`.localeCompare(
          `${right.coverageId}:${right.kind}:${right.path ?? ""}:${right.role}`,
        ),
      ),
      scenarioRefs: uniqueSorted(categoryScenarioRefs),
      missingCoverageIds: uniqueSorted(missingCoverageIds),
      missingEvidenceRefs: uniqueSorted(missingEvidenceRefsByCategoryId.get(categoryId) ?? []),
    });
  }

  const requiredCategories = categories.filter((category) => category.profiles.length > 0);
  const fulfilledCategoryCount = requiredCategories.filter(
    (category) => category.coverageStatus === "covered",
  ).length;
  const unknownCoverageIds = allScenarioCoverageIds.filter(
    (coverageId) => !maturityRefs.coverageIds.has(coverageId),
  );

  return {
    taxonomyPath:
      params.taxonomyPath === undefined ? QA_MATURITY_TAXONOMY_PATH : params.taxonomyPath,
    title: params.taxonomy?.title ?? null,
    taxonomy: params.taxonomy
      ? {
          sourcePath: QA_MATURITY_TAXONOMY_PATH,
        }
      : null,
    profileCount: params.taxonomy?.profiles.length ?? 0,
    profiles,
    categoryCount: maturityRefs.categories.size,
    requiredCategoryCount: requiredCategories.length,
    fulfilledCategoryCount,
    categoryFulfillmentPercent: percent(fulfilledCategoryCount, requiredCategories.length),
    requiredCoverageIdCount: requiredCoverageIds.size,
    fulfilledCoverageIdCount: fulfilledRequiredCoverageIds.size,
    coverageIdFulfillmentPercent: percent(
      fulfilledRequiredCoverageIds.size,
      requiredCoverageIds.size,
    ),
    evidenceRefCount: categories.reduce((count, category) => count + category.evidence.length, 0),
    scenarioCoverageIdCount: allScenarioCoverageIds.length,
    unknownCoverageIdCount: unknownCoverageIds.length,
    unknownCoverageIds,
    validationIssueCount: issues.length,
    validationIssues: issues,
    categories,
  };
}

export function readQaScorecardTaxonomyReport(scenarios: readonly QaSeedScenarioWithSource[]) {
  const taxonomyPath = resolveRepoPath(QA_MATURITY_TAXONOMY_PATH, "file");
  const repoRoot = taxonomyPath ? repoRootFromPath(taxonomyPath) : undefined;
  return buildQaScorecardTaxonomyReport({
    taxonomy: readQaMaturityTaxonomy(repoRoot),
    taxonomyPath: taxonomyPath ? QA_MATURITY_TAXONOMY_PATH : null,
    repoRoot,
    scenarios,
  });
}
