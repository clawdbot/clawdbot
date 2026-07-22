// Qa Lab plugin module implements QA evidence summary behavior.
import { z } from "zod";
import { qaCoverageIdSchema } from "./coverage-id.js";
import { resolveQaEvidenceEnvironment } from "./evidence-environment.js";
import { splitQaModelRef } from "./model-selection.js";
import { getQaProvider, type QaProviderMode } from "./providers/index.js";
import {
  qaScorecardEvidenceModeSchema,
  readQaScorecardProfileOptions,
  type QaScorecardEvidenceMode,
} from "./scorecard-taxonomy.js";

export const QA_EVIDENCE_SUMMARY_KIND = "openclaw.qa.evidence-summary";
export const QA_EVIDENCE_FILENAME = "qa-evidence.json";
// v2 was introduced on this PR series and has no stable external readers yet.
// Keep the version while the pre-release evidence shape settles.
export const QA_EVIDENCE_SUMMARY_SCHEMA_VERSION = 2;

const qaEvidenceStatusSchema = z.enum(["pass", "fail", "blocked", "skipped"]);
const nonEmptyStringSchema = z.string().trim().min(1);
const nullableStringSchema = nonEmptyStringSchema.nullable();
const qaEvidenceProfileIdSchema = nonEmptyStringSchema;

const qaEvidenceProviderSchema = z.strictObject({
  id: nonEmptyStringSchema,
  live: z.boolean(),
  model: z.strictObject({
    name: nullableStringSchema,
    ref: nullableStringSchema,
  }),
  fixture: nonEmptyStringSchema.optional(),
  auth: nonEmptyStringSchema.optional(),
});

const qaEvidenceChannelSchema = z.strictObject({
  id: nonEmptyStringSchema,
  live: z.boolean(),
  driver: nonEmptyStringSchema.optional(),
});

const qaEvidenceEnvironmentSchema = z.strictObject({
  ref: nullableStringSchema,
  os: nonEmptyStringSchema,
  nodeVersion: nonEmptyStringSchema,
});

const qaEvidencePackageSourceSchema = z.strictObject({
  kind: nonEmptyStringSchema,
  spec: nonEmptyStringSchema.optional(),
  sha: nonEmptyStringSchema.optional(),
});

const qaEvidenceFailureSchema = z.strictObject({
  class: nonEmptyStringSchema.optional(),
  reason: nonEmptyStringSchema,
});

const qaEvidenceTimingSchema = z.strictObject({
  wallMs: z.number().finite().positive().optional(),
  rttMs: z.number().finite().positive().optional(),
  avgMs: z.number().finite().positive().optional(),
  p50Ms: z.number().finite().positive().optional(),
  p95Ms: z.number().finite().positive().optional(),
  maxMs: z.number().finite().positive().optional(),
  samples: z.number().int().positive().optional(),
  failedSamples: z.number().int().nonnegative().optional(),
});

const qaEvidenceTestSchema = z.strictObject({
  kind: nonEmptyStringSchema,
  id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  source: z
    .strictObject({
      path: nonEmptyStringSchema,
    })
    .optional(),
});

const qaEvidenceRefSchema = z.strictObject({
  kind: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
});

const qaEvidenceCoverageSchema = z.strictObject({
  id: qaCoverageIdSchema,
  role: nonEmptyStringSchema,
});

const qaEvidenceScorecardCountSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  fulfilled: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative().optional(),
  missing: z.number().int().nonnegative(),
  fulfillmentPercent: z.number().finite().nonnegative(),
});

const qaEvidenceScorecardCoverageCountSchema = qaEvidenceScorecardCountSchema.extend({
  secondaryOnly: z.number().int().nonnegative(),
});

const qaEvidenceScorecardCategorySchema = z.strictObject({
  id: nonEmptyStringSchema,
  surfaceId: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  status: z.enum(["fulfilled", "partial", "missing"]),
  features: qaEvidenceScorecardCountSchema,
  coverageIds: qaEvidenceScorecardCoverageCountSchema,
  missingCoverageIds: z.array(nonEmptyStringSchema),
});

const qaEvidenceScorecardSchema = z.strictObject({
  filters: z.strictObject({
    surface: nullableStringSchema,
    category: nullableStringSchema,
  }),
  run: z.strictObject({
    evidenceEntryCount: z.number().int().nonnegative(),
  }),
  categories: qaEvidenceScorecardCountSchema,
  features: qaEvidenceScorecardCountSchema,
  coverageIds: qaEvidenceScorecardCountSchema,
  categoryReports: z.array(qaEvidenceScorecardCategorySchema),
});

const qaEvidenceArtifactSchema = z.strictObject({
  kind: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  source: nonEmptyStringSchema,
});

const qaEvidenceExecutionSchema = z.strictObject({
  runner: nonEmptyStringSchema,
  environment: qaEvidenceEnvironmentSchema,
  provider: qaEvidenceProviderSchema,
  channel: qaEvidenceChannelSchema.optional(),
  packageSource: qaEvidencePackageSourceSchema,
  artifacts: z.array(qaEvidenceArtifactSchema),
});

const qaEvidenceResultSchema = z.strictObject({
  status: qaEvidenceStatusSchema,
  failure: qaEvidenceFailureSchema.optional(),
  timing: qaEvidenceTimingSchema.optional(),
});

const qaEvidencePostureSchema = z.enum(["direct-gateway", "native-approval", "user-path"]);

const qaEvidenceSummaryEntrySchema = z.strictObject({
  test: qaEvidenceTestSchema,
  coverage: z.array(qaEvidenceCoverageSchema),
  posture: qaEvidencePostureSchema.optional(),
  refs: z.array(qaEvidenceRefSchema).optional(),
  runtimeParityTier: nonEmptyStringSchema.optional(),
  execution: qaEvidenceExecutionSchema.optional(),
  result: qaEvidenceResultSchema,
});

const qaEvidenceSummarySchema = z.strictObject({
  kind: z.literal(QA_EVIDENCE_SUMMARY_KIND),
  schemaVersion: z.literal(QA_EVIDENCE_SUMMARY_SCHEMA_VERSION),
  generatedAt: nonEmptyStringSchema,
  evidenceMode: qaScorecardEvidenceModeSchema,
  entries: z.array(qaEvidenceSummaryEntrySchema),
  profile: qaEvidenceProfileIdSchema.optional(),
  scorecard: qaEvidenceScorecardSchema.optional(),
});

type QaEvidenceProfile = z.infer<typeof qaEvidenceProfileIdSchema>;
export type QaEvidenceStatus = z.infer<typeof qaEvidenceStatusSchema>;
export type QaEvidenceTiming = z.infer<typeof qaEvidenceTimingSchema>;
export type QaEvidencePackageSource = z.infer<typeof qaEvidencePackageSourceSchema>;
export type QaEvidenceScorecardJson = z.infer<typeof qaEvidenceScorecardSchema>;
export type QaEvidenceSummaryEntry = z.infer<typeof qaEvidenceSummaryEntrySchema>;
export type QaEvidenceSummaryJson = z.infer<typeof qaEvidenceSummarySchema>;

type QaEvidenceStatusInput = QaEvidenceStatus | "skip";

type QaEvidenceScenarioDefinitionInput = {
  id: string;
  title: string;
  sourcePath?: string;
  surface?: string;
  surfaces?: readonly string[];
  category?: string;
  coverage?: {
    primary?: readonly string[];
    secondary?: readonly string[];
  };
  runtimeParityTier?: string;
  docsRefs?: readonly string[];
  codeRefs?: readonly string[];
};

type QaEvidenceScenarioResultInput = {
  name: string;
  status: QaEvidenceStatusInput;
  details?: string;
  timing?: QaEvidenceTiming;
  rttMs?: number;
  rttMeasurement?: {
    finalMatchedReplyRttMs?: number;
  };
};

type QaEvidenceRttInput = Pick<
  QaEvidenceScenarioResultInput,
  "rttMeasurement" | "rttMs" | "timing"
>;

type QaEvidenceTestTargetInput = {
  id: string;
  title: string;
  sourcePath: string;
  primaryCoverageIds?: readonly string[];
  secondaryCoverageIds?: readonly string[];
  docsRefs?: readonly string[];
  codeRefs?: readonly string[];
};

type QaEvidenceTestResultInput = {
  id?: string;
  title?: string;
  sourcePath?: string;
  status: QaEvidenceStatusInput;
  durationMs?: number;
  failureMessage?: string;
};

type QaEvidenceArtifactInput = {
  kind: string;
  path: string;
};

type QaEvidenceBuildBase = {
  artifactPaths: readonly QaEvidenceArtifactInput[];
  evidenceMode?: QaScorecardEvidenceMode;
  env?: NodeJS.ProcessEnv;
  generatedAt: string;
  primaryModel: string;
  providerMode: QaProviderMode;
  channelDriver?: string;
  packageSource?: QaEvidencePackageSource;
  profile?: QaEvidenceProfile;
  repoRoot?: string;
  runner?: string;
};

function buildQaEvidenceRefs(params: {
  docsRefs?: readonly string[];
  codeRefs?: readonly string[];
}) {
  const buildRef = (kind: "docs" | "code", refPath: string) => {
    const ref = {
      kind,
      path: refPath,
    };
    return ref;
  };
  const refs = [
    ...(params.docsRefs ?? []).map((path) => buildRef("docs", path)),
    ...(params.codeRefs ?? []).map((path) => buildRef("code", path)),
  ];
  return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.path}`, ref])).values()];
}

function buildQaEvidenceCoverage(params: {
  primaryCoverageIds?: readonly string[];
  secondaryCoverageIds?: readonly string[];
}) {
  const buildCoverage = (id: string, role: "primary" | "secondary") => ({
    id,
    role,
  });
  return [
    ...uniqueSortedStrings(params.primaryCoverageIds ?? []).map((id) =>
      buildCoverage(id, "primary"),
    ),
    ...uniqueSortedStrings(params.secondaryCoverageIds ?? []).map((id) =>
      buildCoverage(id, "secondary"),
    ),
  ];
}

function buildQaEvidenceArtifacts(paths: readonly QaEvidenceArtifactInput[], source: string) {
  return paths.map((artifact) => ({
    kind: artifact.kind,
    path: artifact.path,
    source,
  }));
}

function uniqueSortedStrings(values: readonly (string | undefined)[]) {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])].toSorted(
    (left, right) => left.localeCompare(right),
  );
}

export function resolveQaEvidenceProfile(params: {
  env?: NodeJS.ProcessEnv;
  explicit?: QaEvidenceProfile;
}) {
  if (params.explicit) {
    const explicit = params.explicit.trim();
    if (!explicit) {
      throw new Error("evidence profile must be a non-empty string.");
    }
    return explicit;
  }

  const envProfiles = [
    ["OPENCLAW_E2E_PROFILE", params.env?.OPENCLAW_E2E_PROFILE],
    ["OPENCLAW_QA_PROFILE", params.env?.OPENCLAW_QA_PROFILE],
  ] as const;
  for (const [, value] of envProfiles) {
    const normalized = value?.trim();
    if (!normalized) {
      continue;
    }
    return normalized;
  }

  return undefined;
}

function resolveQaEvidenceRunner(params: { env?: NodeJS.ProcessEnv; fallback?: string }) {
  return params.env?.OPENCLAW_QA_RUNNER?.trim() || params.fallback || "host";
}

function resolveQaEvidenceChannelDriver(params: { env?: NodeJS.ProcessEnv; fallback?: string }) {
  const id =
    params.fallback?.trim() ||
    params.env?.OPENCLAW_QA_CHANNEL_DRIVER?.trim() ||
    params.env?.OPENCLAW_E2E_CHANNEL_DRIVER?.trim();
  return id ? { id } : undefined;
}

function resolveQaEvidencePackageSource(env: NodeJS.ProcessEnv | undefined) {
  const spec = env?.OPENCLAW_QA_PACKAGE_SOURCE?.trim() || undefined;
  const sha = env?.OPENCLAW_QA_PACKAGE_SOURCE_SHA?.trim() || undefined;
  const explicitKind = env?.OPENCLAW_QA_PACKAGE_SOURCE_KIND?.trim();
  const kind =
    explicitKind ||
    (spec && spec.endsWith(".tgz") ? "packed-tarball" : spec ? "npm-package" : "source-checkout");
  return {
    kind,
    spec,
    sha,
  };
}

function resolveQaEvidenceBuildPackageSource(params: QaEvidenceBuildBase) {
  return params.packageSource ?? resolveQaEvidencePackageSource(params.env);
}

function buildQaEvidenceProvider(params: { providerMode: QaProviderMode; primaryModel: string }) {
  const provider = getQaProvider(params.providerMode);
  const split = splitQaModelRef(params.primaryModel);
  const providerShape = {
    id: split?.provider ?? params.providerMode,
    model: {
      name: split?.model ?? null,
      ref: params.primaryModel || null,
    },
  };
  if (provider.kind === "live") {
    return {
      ...providerShape,
      live: true,
      auth: params.providerMode,
    };
  }
  const mockProviderId =
    split?.provider && split.provider !== params.providerMode
      ? split.provider
      : params.providerMode === "mock-openai"
        ? "openai"
        : (split?.provider ?? params.providerMode);
  return {
    ...providerShape,
    id: mockProviderId,
    live: false,
    fixture: params.providerMode,
  };
}

function normalizeQaEvidenceStatus(status: QaEvidenceStatusInput): QaEvidenceStatus {
  return status === "skip" ? "skipped" : status;
}

function failureForResult(result: {
  details?: string;
  failureMessage?: string;
  status: QaEvidenceStatusInput;
}) {
  const status = normalizeQaEvidenceStatus(result.status);
  if (status === "pass") {
    return undefined;
  }
  return {
    reason: result.details?.trim() || result.failureMessage?.trim() || `${status} test`,
  };
}

function timingForRttResult(check: QaEvidenceRttInput) {
  const timing: QaEvidenceTiming = { ...check.timing };
  const rttMs = check.rttMeasurement?.finalMatchedReplyRttMs ?? check.rttMs;
  if (
    timing.rttMs === undefined &&
    typeof rttMs === "number" &&
    Number.isFinite(rttMs) &&
    rttMs > 0
  ) {
    timing.rttMs = rttMs;
  }
  return Object.keys(timing).length > 0 ? timing : undefined;
}

function timingForTestResult(result: QaEvidenceTestResultInput) {
  return typeof result.durationMs === "number" &&
    Number.isFinite(result.durationMs) &&
    result.durationMs > 0
    ? { wallMs: result.durationMs }
    : undefined;
}

function resultForEvidence(
  result: { details?: string; failureMessage?: string; status: QaEvidenceStatusInput },
  timing?: QaEvidenceTiming,
) {
  return {
    status: normalizeQaEvidenceStatus(result.status),
    failure: failureForResult(result),
    timing,
  };
}

function buildQaEvidenceSummary(params: {
  entries: QaEvidenceSummaryEntry[];
  evidenceMode?: QaScorecardEvidenceMode;
  generatedAt: string;
  profile?: QaEvidenceProfile;
  scorecard?: QaEvidenceScorecardJson;
}): QaEvidenceSummaryJson {
  const profileOptions = readQaScorecardProfileOptions(params.profile);
  const evidenceMode = params.evidenceMode ?? profileOptions.evidenceMode;
  const entries =
    evidenceMode === "slim"
      ? params.entries.map((entry) => {
          const { execution: _execution, ...withoutExecution } = entry;
          return withoutExecution;
        })
      : params.entries;
  return qaEvidenceSummarySchema.parse({
    kind: QA_EVIDENCE_SUMMARY_KIND,
    schemaVersion: QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
    generatedAt: params.generatedAt,
    evidenceMode,
    entries,
    profile: params.profile,
    scorecard: params.scorecard,
  });
}

export function validateQaEvidenceSummaryJson(summary: unknown): QaEvidenceSummaryJson {
  return qaEvidenceSummarySchema.parse(summary);
}

export function attachQaEvidenceScorecard(params: {
  evidenceMode?: QaScorecardEvidenceMode;
  summary: QaEvidenceSummaryJson;
  profile: QaEvidenceProfile;
  scorecard: QaEvidenceScorecardJson;
}): QaEvidenceSummaryJson {
  return buildQaEvidenceSummary({
    entries: params.summary.entries,
    evidenceMode: params.evidenceMode,
    generatedAt: params.summary.generatedAt,
    profile: params.profile,
    scorecard: params.scorecard,
  });
}

export function buildQaSuiteEvidenceSummary(
  params: QaEvidenceBuildBase & {
    channelId: string;
    scenarioDefinitions: readonly QaEvidenceScenarioDefinitionInput[];
    scenarioResults: readonly QaEvidenceScenarioResultInput[];
  },
): QaEvidenceSummaryJson {
  const provider = buildQaEvidenceProvider(params);
  const environment = resolveQaEvidenceEnvironment({
    env: params.env,
    repoRoot: params.repoRoot,
  });
  const packageSource = resolveQaEvidenceBuildPackageSource(params);
  const runner = resolveQaEvidenceRunner({ env: params.env, fallback: params.runner });
  const profile = resolveQaEvidenceProfile({
    env: params.env,
    explicit: params.profile,
  });
  const channelDriver = resolveQaEvidenceChannelDriver({
    env: params.env,
    fallback: params.channelDriver,
  });
  const entries = params.scenarioResults.map((result, index): QaEvidenceSummaryEntry => {
    const scenario = params.scenarioDefinitions[index];
    const primaryCoverageIds = uniqueSortedStrings(scenario?.coverage?.primary ?? []);
    const coverageIds = uniqueSortedStrings([
      ...(scenario?.coverage?.primary ?? []),
      ...(scenario?.coverage?.secondary ?? []),
    ]);
    const runtimeParityTier = scenario?.runtimeParityTier;
    const testId = scenario?.id ?? `scenario-${index + 1}`;
    const refs = buildQaEvidenceRefs({
      docsRefs: scenario?.docsRefs,
      codeRefs: scenario?.codeRefs,
    });
    const timing = timingForRttResult(result);
    return {
      test: {
        kind: "qa-scenario",
        id: testId,
        title: scenario?.title ?? result.name,
        source: scenario?.sourcePath ? { path: scenario.sourcePath } : undefined,
      },
      coverage: buildQaEvidenceCoverage({
        primaryCoverageIds,
        secondaryCoverageIds: coverageIds.filter(
          (coverageId) => !primaryCoverageIds.includes(coverageId),
        ),
      }),
      refs: refs.length > 0 ? refs : undefined,
      runtimeParityTier,
      execution: {
        runner,
        environment,
        provider,
        channel: {
          id: params.channelId,
          live: false,
          driver: channelDriver?.id,
        },
        packageSource,
        artifacts: buildQaEvidenceArtifacts(params.artifactPaths, "qa-suite"),
      },
      result: resultForEvidence(result, timing),
    };
  });
  return buildQaEvidenceSummary({
    entries,
    evidenceMode: params.evidenceMode,
    generatedAt: params.generatedAt,
    profile,
  });
}

function buildTestRunnerEvidenceSummary(
  params: QaEvidenceBuildBase & {
    defaultRunner: string;
    testKind: string;
    targets: readonly QaEvidenceTestTargetInput[];
    results: readonly QaEvidenceTestResultInput[];
  },
): QaEvidenceSummaryJson {
  const provider = buildQaEvidenceProvider(params);
  const environment = resolveQaEvidenceEnvironment({
    env: params.env,
    repoRoot: params.repoRoot,
  });
  const packageSource = resolveQaEvidenceBuildPackageSource(params);
  const runner = resolveQaEvidenceRunner({
    env: params.env,
    fallback: params.runner ?? params.defaultRunner,
  });
  const profile = resolveQaEvidenceProfile({
    env: params.env,
    explicit: params.profile,
  });
  const targetById = new Map(params.targets.map((target) => [target.id, target]));
  const targetByPath = new Map(params.targets.map((target) => [target.sourcePath, target]));
  const entries = params.results.map((result, index): QaEvidenceSummaryEntry => {
    const target = result.id
      ? targetById.get(result.id)
      : result.sourcePath
        ? targetByPath.get(result.sourcePath)
        : undefined;
    const fallbackId = result.id ?? result.sourcePath ?? `test-${index + 1}`;
    const sourcePath = target?.sourcePath ?? result.sourcePath;
    const refs = buildQaEvidenceRefs({
      docsRefs: target?.docsRefs,
      codeRefs: target?.codeRefs,
    });
    const timing = timingForTestResult(result);
    return {
      test: {
        kind: params.testKind,
        id: target?.id ?? fallbackId,
        title: target?.title ?? result.title ?? fallbackId,
        source: sourcePath ? { path: sourcePath } : undefined,
      },
      coverage: buildQaEvidenceCoverage({
        primaryCoverageIds: target?.primaryCoverageIds ?? [],
        secondaryCoverageIds: target?.secondaryCoverageIds ?? [],
      }),
      refs: refs.length > 0 ? refs : undefined,
      execution: {
        runner,
        environment,
        provider,
        packageSource,
        artifacts: buildQaEvidenceArtifacts(params.artifactPaths, runner),
      },
      result: resultForEvidence(result, timing),
    };
  });
  return buildQaEvidenceSummary({
    entries,
    evidenceMode: params.evidenceMode,
    generatedAt: params.generatedAt,
    profile,
  });
}

export function buildVitestEvidenceSummary(
  params: QaEvidenceBuildBase & {
    targets: readonly QaEvidenceTestTargetInput[];
    results: readonly QaEvidenceTestResultInput[];
  },
): QaEvidenceSummaryJson {
  return buildTestRunnerEvidenceSummary({
    ...params,
    defaultRunner: "vitest",
    testKind: "vitest-test",
    runner: params.runner ?? "vitest",
  });
}

export function buildPlaywrightEvidenceSummary(
  params: QaEvidenceBuildBase & {
    targets: readonly QaEvidenceTestTargetInput[];
    results: readonly QaEvidenceTestResultInput[];
  },
): QaEvidenceSummaryJson {
  return buildTestRunnerEvidenceSummary({
    ...params,
    defaultRunner: "playwright",
    testKind: "playwright-test",
    runner: params.runner ?? "playwright",
  });
}

export function buildScriptEvidenceSummary(
  params: QaEvidenceBuildBase & {
    targets: readonly QaEvidenceTestTargetInput[];
    results: readonly QaEvidenceTestResultInput[];
  },
): QaEvidenceSummaryJson {
  return buildTestRunnerEvidenceSummary({
    ...params,
    defaultRunner: "script",
    testKind: "script-test",
    runner: params.runner ?? "script",
  });
}
