// Qa Lab plugin module implements confidence report behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  formatGatewayLogSentinelSummary,
  type GatewayLogSentinelFinding,
} from "./gateway-log-sentinel.js";
import {
  buildHarnessParityCell,
  buildHarnessParityResult,
  type HarnessParityDrift,
  type HarnessRuntimeParityCell,
  type RuntimeParitySystemPromptReport,
} from "./harness-parity.js";
import {
  runRuntimeParityScenario,
  type RuntimeParityCell,
  type RuntimeParityDrift,
  type RuntimeParityResult,
  type RuntimeParityToolCall,
} from "./runtime-parity.js";
import { buildTokenEfficiencyReport } from "./token-efficiency-report.js";

export const QA_CONFIDENCE_VERDICTS = [
  "pass",
  "product-bug",
  "qa-harness-bug",
  "fixture-bug",
  "optional-gap",
  "mock-limitation",
  "environment-blocked",
] as const;

export type QaConfidenceVerdict = (typeof QA_CONFIDENCE_VERDICTS)[number];

export type QaConfidenceLaneKind =
  | "qa-suite-summary"
  | "runtime-parity-summary"
  | "harness-parity-summary"
  | "token-efficiency-summary"
  | "jsonl-replay-summary"
  | "self-test-summary"
  | "generic-pass-summary";

export type QaConfidenceManifestLane = {
  id: string;
  title: string;
  kind: QaConfidenceLaneKind;
  artifact: string;
  required: boolean;
  failureVerdict?: Exclude<QaConfidenceVerdict, "pass" | "environment-blocked">;
  missingVerdict?: "environment-blocked" | "optional-gap";
  missingReason?: string;
  expectedTokenUsageSource?: "mock-estimate" | "live-usage";
  skipBackfillLane?: string;
  productImpact?: string;
  qaImpact?: string;
  issue?: string;
  ownerAction?: string;
  labels?: string[];
};

export type QaConfidenceManifest = {
  version: 1;
  profile: string;
  lanes: QaConfidenceManifestLane[];
};

export type QaConfidenceLaneStatus = "pass" | "fail" | "blocked" | "missing" | "unknown";

export type QaConfidenceLaneResult = {
  id: string;
  title: string;
  kind: QaConfidenceLaneKind;
  artifact: string;
  artifactPath: string;
  required: boolean;
  status: QaConfidenceLaneStatus;
  verdict?: QaConfidenceVerdict;
  details: string;
  productImpact?: string;
  qaImpact?: string;
  issue?: string;
  ownerAction?: string;
  labels?: string[];
  skippedCount?: number;
  skipBackfillLane?: string;
  skipBackfilled?: boolean;
};

export type QaConfidenceReport = {
  generatedAt: string;
  profile: string;
  strictZeroUnknowns: boolean;
  strictGlobalPass: boolean;
  pass: boolean;
  zeroUnknowns: boolean;
  globalPass: boolean;
  counts: {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
    missing: number;
    unknown: number;
  };
  failures: string[];
  lanes: QaConfidenceLaneResult[];
};

export type QaConfidenceSelfTestCanary = {
  id: string;
  category:
    | "prompt"
    | "tool-schema"
    | "tool-call"
    | "tool-result"
    | "failure-mode"
    | "token-efficiency"
    | "jsonl-replay";
  detected: boolean;
  expectedVerdict: Exclude<QaConfidenceVerdict, "pass" | "environment-blocked">;
  details: string;
};

export type QaConfidenceSelfTestSummary = {
  generatedAt: string;
  pass: boolean;
  canaries: QaConfidenceSelfTestCanary[];
};

const QA_CONFIDENCE_SELF_TEST_CANARY_IDS = [
  "prompt-drift",
  "tool-description-schema-drift",
  "runtime-tool-call-drop",
  "tool-result-mismatch",
  "failure-mode-drift",
  "token-efficiency-regression",
  "jsonl-replay-ordering-drift",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.filter((entry): entry is string => typeof entry === "string");
  return values.length === value.length ? values : undefined;
}

function isGatewayLogSentinelFinding(value: unknown): value is GatewayLogSentinelFinding {
  if (!isRecord(value)) {
    return false;
  }
  const kind = readString(value.kind);
  const verdict = readString(value.verdict);
  return Boolean(kind && verdict && isQaConfidenceVerdict(verdict));
}

function collectGatewayLogSentinels(value: unknown): GatewayLogSentinelFinding[] {
  const findings: GatewayLogSentinelFinding[] = [];
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        visit(entry);
      }
      return;
    }
    if (!isRecord(candidate)) {
      return;
    }
    if (Array.isArray(candidate.gatewayLogSentinels)) {
      findings.push(...candidate.gatewayLogSentinels.filter(isGatewayLogSentinelFinding));
    }
    if (Array.isArray(candidate.sentinelFindings)) {
      findings.push(...candidate.sentinelFindings.filter(isGatewayLogSentinelFinding));
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (key === "gatewayLogSentinels" || key === "sentinelFindings") {
        continue;
      }
      visit(nested);
    }
  };
  visit(value);
  return findings;
}

function isQaConfidenceVerdict(value: string): value is QaConfidenceVerdict {
  return QA_CONFIDENCE_VERDICTS.includes(value as QaConfidenceVerdict);
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = readString(record[key]);
  if (!value) {
    throw new Error(`confidence manifest lane missing ${key}`);
  }
  return value;
}

function readVerdict(value: unknown, key: string): QaConfidenceVerdict | undefined {
  const text = readString(value);
  if (!text) {
    return undefined;
  }
  if (!isQaConfidenceVerdict(text)) {
    throw new Error(
      `confidence manifest ${key} must be one of ${QA_CONFIDENCE_VERDICTS.join(", ")}`,
    );
  }
  return text;
}

function readLaneKind(value: unknown): QaConfidenceLaneKind {
  const text = readString(value);
  switch (text) {
    case "qa-suite-summary":
    case "runtime-parity-summary":
    case "harness-parity-summary":
    case "token-efficiency-summary":
    case "jsonl-replay-summary":
    case "self-test-summary":
    case "generic-pass-summary":
      return text;
    default:
      throw new Error(`unknown confidence manifest lane kind: ${text ?? "missing"}`);
  }
}

function normalizeManifestLane(value: unknown): QaConfidenceManifestLane {
  if (!isRecord(value)) {
    throw new Error("confidence manifest lanes must be objects");
  }
  const failureVerdict = readVerdict(value.failureVerdict, "failureVerdict");
  if (failureVerdict === "pass" || failureVerdict === "environment-blocked") {
    throw new Error("confidence manifest failureVerdict must classify an actual failure");
  }
  const missingVerdict = readVerdict(value.missingVerdict, "missingVerdict");
  if (
    missingVerdict !== undefined &&
    missingVerdict !== "environment-blocked" &&
    missingVerdict !== "optional-gap"
  ) {
    throw new Error(
      "confidence manifest missingVerdict must be environment-blocked or optional-gap",
    );
  }
  const expectedTokenUsageSource = readString(value.expectedTokenUsageSource);
  if (
    expectedTokenUsageSource !== undefined &&
    expectedTokenUsageSource !== "mock-estimate" &&
    expectedTokenUsageSource !== "live-usage"
  ) {
    throw new Error(
      "confidence manifest expectedTokenUsageSource must be mock-estimate or live-usage",
    );
  }
  return {
    id: readRequiredString(value, "id"),
    title: readRequiredString(value, "title"),
    kind: readLaneKind(value.kind),
    artifact: readRequiredString(value, "artifact"),
    required: readBoolean(value.required) ?? true,
    ...(failureVerdict ? { failureVerdict } : {}),
    ...(missingVerdict ? { missingVerdict } : {}),
    ...(readString(value.missingReason) ? { missingReason: readString(value.missingReason) } : {}),
    ...(expectedTokenUsageSource ? { expectedTokenUsageSource } : {}),
    ...(readString(value.skipBackfillLane)
      ? { skipBackfillLane: readString(value.skipBackfillLane) }
      : {}),
    ...(readString(value.productImpact) ? { productImpact: readString(value.productImpact) } : {}),
    ...(readString(value.qaImpact) ? { qaImpact: readString(value.qaImpact) } : {}),
    ...(readString(value.issue) ? { issue: readString(value.issue) } : {}),
    ...(readString(value.ownerAction) ? { ownerAction: readString(value.ownerAction) } : {}),
    ...(readStringArray(value.labels) ? { labels: readStringArray(value.labels) } : {}),
  };
}

export function normalizeQaConfidenceManifest(value: unknown): QaConfidenceManifest {
  if (!isRecord(value)) {
    throw new Error("confidence manifest must be an object");
  }
  if (value.version !== 1) {
    throw new Error("confidence manifest version must be 1");
  }
  const profile = readString(value.profile);
  if (!profile) {
    throw new Error("confidence manifest missing profile");
  }
  if (!Array.isArray(value.lanes) || value.lanes.length === 0) {
    throw new Error("confidence manifest must include at least one lane");
  }
  const lanes = value.lanes.map(normalizeManifestLane);
  const ids = new Set<string>();
  for (const lane of lanes) {
    if (ids.has(lane.id)) {
      throw new Error(`confidence manifest duplicate lane id: ${lane.id}`);
    }
    ids.add(lane.id);
  }
  return {
    version: 1,
    profile,
    lanes,
  };
}

export async function readQaConfidenceManifestFile(
  filePath: string,
): Promise<QaConfidenceManifest> {
  let payload: unknown;
  try {
    payload = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Could not read confidence manifest at ${filePath}: ${formatErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
  return normalizeQaConfidenceManifest(payload);
}

function resolveArtifactPath(artifactRoot: string, artifact: string): string {
  return path.isAbsolute(artifact) ? artifact : path.resolve(artifactRoot, artifact);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function statusFromPassed(passed: boolean): Pick<QaConfidenceLaneResult, "status" | "verdict"> {
  return passed ? { status: "pass", verdict: "pass" } : { status: "unknown" };
}

type QaConfidenceLaneEvaluation = {
  passed: boolean;
  details: string;
  skippedCount?: number;
  status?: QaConfidenceLaneStatus;
  verdict?: QaConfidenceVerdict;
};

function evaluateQaSuiteSummary(payload: unknown): QaConfidenceLaneEvaluation {
  if (!isRecord(payload)) {
    return {
      passed: false,
      status: "unknown",
      details: "qa-suite-summary payload was not an object",
    };
  }
  const counts = isRecord(payload.counts) ? payload.counts : undefined;
  const totalCount = readNumber(counts?.total);
  const passedCount = readNumber(counts?.passed);
  const failedCount = readNumber(counts?.failed);
  const scenarios = Array.isArray(payload.scenarios) ? payload.scenarios : undefined;
  const failedScenarios = scenarios?.filter(
    (scenario) => isRecord(scenario) && scenario.status === "fail",
  );
  const skippedScenarioCount =
    scenarios?.filter(
      (scenario) =>
        isRecord(scenario) && (scenario.status === "skip" || scenario.status === "skipped"),
    ).length ?? 0;
  const unknownBlockingScenarioCount =
    scenarios?.filter(
      (scenario) =>
        !isRecord(scenario) ||
        (scenario.status !== "pass" &&
          scenario.status !== "fail" &&
          scenario.status !== "skip" &&
          scenario.status !== "skipped"),
    ).length ?? 0;
  const hasScenarioRows = scenarios !== undefined && scenarios.length > 0;
  const gatewayLogSentinels = collectGatewayLogSentinels(payload);
  if (gatewayLogSentinels.length > 0) {
    const allEnvironmentBlocked = gatewayLogSentinels.every(
      (finding) => finding.verdict === "environment-blocked",
    );
    const suiteHasFailures =
      (failedCount !== undefined && failedCount > 0) || (failedScenarios?.length ?? 0) > 0;
    if (allEnvironmentBlocked && suiteHasFailures) {
      return {
        passed: false,
        status: "unknown",
        details: `gateway log sentinel(s): ${formatGatewayLogSentinelSummary(
          gatewayLogSentinels,
        )}; suite also reports failures`,
      };
    }
    const firstBlockingSentinel =
      gatewayLogSentinels.find((finding) => finding.verdict !== "environment-blocked") ??
      gatewayLogSentinels[0];
    return {
      passed: false,
      status: allEnvironmentBlocked ? "blocked" : "fail",
      verdict: allEnvironmentBlocked
        ? "environment-blocked"
        : (firstBlockingSentinel?.verdict ?? "product-bug"),
      details: `gateway log sentinel(s): ${formatGatewayLogSentinelSummary(gatewayLogSentinels)}`,
    };
  }
  if (failedCount !== undefined) {
    if (failedCount === 0 && !(totalCount !== undefined && totalCount > 0) && !hasScenarioRows) {
      return {
        passed: false,
        status: "unknown",
        details: "qa-suite-summary has no executed scenarios",
      };
    }
    if (failedScenarios !== undefined && Math.floor(failedCount) !== failedScenarios.length) {
      return {
        passed: false,
        status: "unknown",
        details: `qa-suite-summary count/scenario mismatch: counts.failed=${Math.max(
          0,
          Math.floor(failedCount),
        )}, failed scenarios=${failedScenarios.length}`,
      };
    }
    if (unknownBlockingScenarioCount > 0) {
      return {
        passed: false,
        status: "unknown",
        details: `qa-suite-summary has ${unknownBlockingScenarioCount} scenario row(s) with unsupported non-pass status`,
      };
    }
    const explicitSkippedCount = readNumber(counts?.skipped);
    const inferredSkippedCount =
      totalCount === undefined || passedCount === undefined
        ? undefined
        : Math.max(0, Math.floor(totalCount) - Math.floor(passedCount) - Math.floor(failedCount));
    const skippedCount = Math.max(
      0,
      ...[explicitSkippedCount, inferredSkippedCount, skippedScenarioCount].filter(
        (count): count is number => count !== undefined,
      ),
    );
    const shouldReportSkippedCount = explicitSkippedCount !== undefined || skippedCount > 0;
    const skippedDetails = shouldReportSkippedCount
      ? ` counts.skipped=${Math.max(0, Math.floor(skippedCount))}`
      : "";
    const totalDetails =
      totalCount === undefined ? "" : ` counts.total=${Math.max(0, Math.floor(totalCount))}`;
    return {
      passed: failedCount === 0,
      details: `qa-suite-summary counts.failed=${Math.max(0, Math.floor(failedCount))}${totalDetails}${skippedDetails}`,
      ...(skippedCount === 0 ? {} : { skippedCount: Math.max(0, Math.floor(skippedCount)) }),
    };
  }
  if (!Array.isArray(payload.scenarios)) {
    return {
      passed: false,
      status: "unknown",
      details: "qa-suite-summary missing counts.failed and scenarios[]",
    };
  }
  if (payload.scenarios.length === 0) {
    return {
      passed: false,
      status: "unknown",
      details: "qa-suite-summary has no executed scenarios",
    };
  }
  const fallbackFailedScenarios = payload.scenarios.filter(
    (scenario) => isRecord(scenario) && scenario.status === "fail",
  );
  const fallbackUnknownBlockingScenarios = payload.scenarios.filter(
    (scenario) =>
      !isRecord(scenario) ||
      (scenario.status !== "pass" &&
        scenario.status !== "fail" &&
        scenario.status !== "skip" &&
        scenario.status !== "skipped"),
  );
  if (fallbackUnknownBlockingScenarios.length > 0) {
    return {
      passed: false,
      status: "unknown",
      details: `qa-suite-summary has ${fallbackUnknownBlockingScenarios.length} scenario row(s) with unsupported non-pass status`,
    };
  }
  return {
    passed: fallbackFailedScenarios.length === 0,
    details: `qa-suite-summary failed scenarios=${fallbackFailedScenarios.length}`,
  };
}

function evaluatePassSummary(payload: unknown): QaConfidenceLaneEvaluation {
  if (!isRecord(payload)) {
    return { passed: false, details: "summary payload was not an object" };
  }
  const pass = readBoolean(payload.pass);
  if (pass !== undefined) {
    return { passed: pass, details: `summary pass=${String(pass)}` };
  }
  const verdict = readString(payload.verdict);
  if (verdict) {
    return { passed: verdict === "pass", details: `summary verdict=${verdict}` };
  }
  const status = readString(payload.status);
  if (status) {
    if (
      status === "pass" ||
      status === "passed" ||
      status === "success" ||
      status === "succeeded"
    ) {
      return { passed: true, details: `summary status=${status}` };
    }
    if (status === "fail" || status === "failed" || status === "error") {
      return { passed: false, details: `summary status=${status}` };
    }
    return {
      passed: false,
      status: "unknown",
      details: `summary status=${status}`,
    };
  }
  return {
    passed: false,
    status: "unknown",
    details: "summary did not expose an explicit pass signal",
  };
}

function evaluateTokenEfficiencySummary(
  payload: unknown,
  expectedTokenUsageSource: QaConfidenceManifestLane["expectedTokenUsageSource"],
): QaConfidenceLaneEvaluation {
  const base = evaluatePassSummary(payload);
  if (!base.passed || !expectedTokenUsageSource) {
    return base;
  }
  if (!isRecord(payload) || !Array.isArray(payload.rows)) {
    return {
      passed: false,
      details: `token summary missing rows for expected usageSource=${expectedTokenUsageSource}`,
    };
  }
  if (readString(payload.status) === "skipped" || payload.rows.length === 0) {
    return {
      passed: false,
      details: `token summary has no ${expectedTokenUsageSource} rows`,
    };
  }
  const mismatched = payload.rows.filter(
    (row) => !isRecord(row) || row.usageSource !== expectedTokenUsageSource,
  );
  return {
    passed: mismatched.length === 0,
    details:
      mismatched.length === 0
        ? `token summary rows all usageSource=${expectedTokenUsageSource}`
        : `token summary has ${mismatched.length} row(s) not labeled ${expectedTokenUsageSource}`,
  };
}

function evaluateJsonlReplaySummary(payload: unknown): QaConfidenceLaneEvaluation {
  if (!isRecord(payload) || !Array.isArray(payload.transcripts)) {
    return {
      passed: false,
      status: "unknown",
      details: "jsonl replay summary missing transcripts array",
    };
  }
  if (payload.transcripts.length === 0) {
    return {
      passed: false,
      status: "unknown",
      details: "jsonl replay summary has no transcripts",
    };
  }
  let drifted = 0;
  let replayedUserTurns = 0;
  for (const transcript of payload.transcripts) {
    if (!isRecord(transcript)) {
      return {
        passed: false,
        status: "unknown",
        details: "jsonl replay summary has an invalid transcript row",
      };
    }
    const userTurnCount = readNumber(transcript.userTurnCount);
    if (userTurnCount !== undefined && userTurnCount > 0) {
      replayedUserTurns += userTurnCount;
    }
    const hasFirstDrift = transcript.firstDriftAtTurn !== undefined;
    if (!Array.isArray(transcript.drift)) {
      return {
        passed: false,
        status: "unknown",
        details: "jsonl replay transcript missing drift array",
      };
    }
    if (userTurnCount !== undefined && transcript.drift.length !== userTurnCount) {
      return {
        passed: false,
        status: "unknown",
        details: "jsonl replay transcript drift count does not match userTurnCount",
      };
    }
    const drift = transcript.drift;
    const hasDrift = drift.some((entry) => entry !== "none");
    if (hasFirstDrift || hasDrift) {
      drifted += 1;
    }
  }
  if (replayedUserTurns === 0) {
    return {
      passed: false,
      status: "unknown",
      details: "jsonl replay summary has no replayed user turns",
    };
  }
  return {
    passed: drifted === 0,
    details: `jsonl replay turns=${replayedUserTurns}, drifted transcripts=${drifted}`,
  };
}

function evaluateSelfTestSummary(payload: unknown): QaConfidenceLaneEvaluation {
  if (!isRecord(payload) || !Array.isArray(payload.canaries)) {
    return {
      passed: false,
      status: "unknown",
      details: "confidence self-test summary missing canaries array",
    };
  }
  if (payload.canaries.length === 0) {
    return {
      passed: false,
      status: "unknown",
      details: "confidence self-test summary has no canaries",
    };
  }
  const canariesById = new Map(
    payload.canaries
      .filter((canary): canary is Record<string, unknown> => isRecord(canary))
      .map((canary) => [readString(canary.id), canary]),
  );
  const missingExpected = QA_CONFIDENCE_SELF_TEST_CANARY_IDS.filter(
    (canaryId) => !canariesById.has(canaryId),
  );
  if (missingExpected.length > 0) {
    return {
      passed: false,
      status: "unknown",
      details: `confidence self-test missing expected canaries: ${missingExpected.join(", ")}`,
    };
  }
  const missed = QA_CONFIDENCE_SELF_TEST_CANARY_IDS.filter(
    (canaryId) => canariesById.get(canaryId)?.detected !== true,
  );
  const pass = readBoolean(payload.pass) ?? missed.length === 0;
  return {
    passed: pass && missed.length === 0,
    details: `confidence self-test detected=${
      QA_CONFIDENCE_SELF_TEST_CANARY_IDS.length - missed.length
    }/${QA_CONFIDENCE_SELF_TEST_CANARY_IDS.length}`,
  };
}

function evaluateLaneArtifact(
  lane: QaConfidenceManifestLane,
  payload: unknown,
): QaConfidenceLaneEvaluation {
  switch (lane.kind) {
    case "qa-suite-summary":
      return evaluateQaSuiteSummary(payload);
    case "runtime-parity-summary":
    case "harness-parity-summary":
    case "generic-pass-summary":
      return evaluatePassSummary(payload);
    case "token-efficiency-summary":
      return evaluateTokenEfficiencySummary(payload, lane.expectedTokenUsageSource);
    case "jsonl-replay-summary":
      return evaluateJsonlReplaySummary(payload);
    case "self-test-summary":
      return evaluateSelfTestSummary(payload);
    default:
      return {
        passed: false,
        details: `unknown confidence lane kind: ${(lane as { kind?: string }).kind ?? "missing"}`,
      };
  }
}

function resultForMissingLane(
  lane: QaConfidenceManifestLane,
  artifactPath: string,
): QaConfidenceLaneResult {
  if (lane.missingVerdict) {
    return {
      ...baseLaneResult(lane, artifactPath),
      status: lane.missingVerdict === "environment-blocked" ? "blocked" : "fail",
      verdict: lane.missingVerdict,
      details: lane.missingReason ?? "artifact missing with explicit missing verdict",
    };
  }
  return {
    ...baseLaneResult(lane, artifactPath),
    status: "missing",
    details: "artifact missing and no missingVerdict was configured",
  };
}

function baseLaneResult(
  lane: QaConfidenceManifestLane,
  artifactPath: string,
): Omit<QaConfidenceLaneResult, "status" | "details"> {
  const reportArtifactPath = path.isAbsolute(lane.artifact)
    ? path.basename(artifactPath)
    : lane.artifact;
  return {
    id: lane.id,
    title: lane.title,
    kind: lane.kind,
    artifact: lane.artifact,
    artifactPath: reportArtifactPath,
    required: lane.required,
    ...(lane.productImpact ? { productImpact: lane.productImpact } : {}),
    ...(lane.qaImpact ? { qaImpact: lane.qaImpact } : {}),
    ...(lane.issue ? { issue: lane.issue } : {}),
    ...(lane.ownerAction ? { ownerAction: lane.ownerAction } : {}),
    ...(lane.labels ? { labels: lane.labels } : {}),
    ...(lane.skipBackfillLane ? { skipBackfillLane: lane.skipBackfillLane } : {}),
  };
}

function classifiedFailureResult(
  lane: QaConfidenceManifestLane,
  artifactPath: string,
  details: string,
): QaConfidenceLaneResult {
  const base = baseLaneResult(lane, artifactPath);
  if (lane.failureVerdict) {
    return {
      ...base,
      status: "fail",
      verdict: lane.failureVerdict,
      details,
    };
  }
  return {
    ...base,
    status: "unknown",
    details,
  };
}

function evaluatedFailureResult(
  lane: QaConfidenceManifestLane,
  artifactPath: string,
  evaluated: QaConfidenceLaneEvaluation,
): QaConfidenceLaneResult {
  if (evaluated.status || evaluated.verdict) {
    return {
      ...baseLaneResult(lane, artifactPath),
      status: evaluated.status ?? "fail",
      ...(evaluated.verdict ? { verdict: evaluated.verdict } : {}),
      details: evaluated.details,
    };
  }
  return classifiedFailureResult(lane, artifactPath, evaluated.details);
}

async function evaluateLane(
  lane: QaConfidenceManifestLane,
  artifactRoot: string,
): Promise<QaConfidenceLaneResult> {
  const artifactPath = resolveArtifactPath(artifactRoot, lane.artifact);
  let payload: unknown;
  try {
    payload = await readJsonFile(artifactPath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      return {
        ...baseLaneResult(lane, artifactPath),
        status: "unknown",
        details: `artifact unreadable: ${formatErrorMessage(error)}`,
      };
    }
    return resultForMissingLane(lane, artifactPath);
  }
  const evaluated = evaluateLaneArtifact(lane, payload);
  if (!evaluated.passed) {
    return {
      ...evaluatedFailureResult(lane, artifactPath, evaluated),
      ...(evaluated.skippedCount === undefined ? {} : { skippedCount: evaluated.skippedCount }),
    };
  }
  return {
    ...baseLaneResult(lane, artifactPath),
    ...statusFromPassed(true),
    details: evaluated.details,
    ...(evaluated.skippedCount === undefined ? {} : { skippedCount: evaluated.skippedCount }),
  };
}

function applySkipBackfillState(
  lanes: readonly QaConfidenceLaneResult[],
): QaConfidenceLaneResult[] {
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  return lanes.map((lane) => {
    if (!lane.skippedCount || lane.skippedCount <= 0 || !lane.skipBackfillLane) {
      return lane;
    }
    const backfillLane = byId.get(lane.skipBackfillLane);
    const skipBackfilled = backfillLane?.status === "pass";
    return {
      ...lane,
      skipBackfilled,
      details: `${lane.details}; skipped rows backfilled by ${lane.skipBackfillLane}: ${
        skipBackfilled ? "yes" : "no"
      }`,
    };
  });
}

function countLaneResults(lanes: readonly QaConfidenceLaneResult[]): QaConfidenceReport["counts"] {
  return {
    total: lanes.length,
    passed: lanes.filter((lane) => lane.status === "pass").length,
    failed: lanes.filter((lane) => lane.status === "fail").length,
    blocked: lanes.filter((lane) => lane.status === "blocked").length,
    missing: lanes.filter((lane) => lane.status === "missing").length,
    unknown: lanes.filter((lane) => lane.status === "unknown" || lane.status === "missing").length,
  };
}

function failuresForLaneResults(lanes: readonly QaConfidenceLaneResult[]): string[] {
  return lanes
    .filter((lane) => lane.status === "unknown" || lane.status === "missing")
    .map((lane) => `${lane.id} is unclassified: ${lane.details}`);
}

function globalFailuresForLaneResults(lanes: readonly QaConfidenceLaneResult[]): string[] {
  return lanes.flatMap((lane) => {
    if (lane.status === "blocked") {
      return [`${lane.id} is blocked: ${lane.details}`];
    }
    if (lane.status === "missing") {
      return [`${lane.id} is missing: ${lane.details}`];
    }
    if (lane.status === "unknown") {
      return [`${lane.id} is unclassified: ${lane.details}`];
    }
    if (lane.status === "fail") {
      return [`${lane.id} is classified ${lane.verdict ?? "unclassified"}: ${lane.details}`];
    }
    if ((lane.skippedCount ?? 0) > 0 && lane.skipBackfilled !== true) {
      return [`${lane.id} has ${lane.skippedCount} skipped row(s) with no passing backfill lane`];
    }
    return [];
  });
}

export async function buildQaConfidenceReport(params: {
  manifest: QaConfidenceManifest;
  artifactRoot: string;
  strictZeroUnknowns?: boolean;
  strictGlobalPass?: boolean;
  generatedAt?: string;
}): Promise<QaConfidenceReport> {
  const evaluatedLanes = [];
  for (const lane of params.manifest.lanes) {
    evaluatedLanes.push(await evaluateLane(lane, params.artifactRoot));
  }
  const lanes = applySkipBackfillState(evaluatedLanes);
  const requiredLanes = lanes.filter((lane) => lane.required);
  const counts = countLaneResults(requiredLanes);
  const unclassifiedFailures = failuresForLaneResults(requiredLanes);
  const globalFailures = globalFailuresForLaneResults(requiredLanes);
  const zeroUnknowns = counts.unknown === 0;
  const globalPass = zeroUnknowns && globalFailures.length === 0;
  const strictZeroUnknowns = params.strictZeroUnknowns === true;
  const strictGlobalPass = params.strictGlobalPass === true;
  return {
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    profile: params.manifest.profile,
    strictZeroUnknowns,
    strictGlobalPass,
    pass: strictGlobalPass
      ? globalPass
      : strictZeroUnknowns
        ? zeroUnknowns
        : unclassifiedFailures.length === 0,
    zeroUnknowns,
    globalPass,
    counts,
    failures: strictGlobalPass ? globalFailures : unclassifiedFailures,
    lanes,
  };
}

function formatVerdict(lane: QaConfidenceLaneResult): string {
  return lane.verdict ?? "unclassified";
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\s+/gu, " ").trim();
}

export function renderQaConfidenceMarkdownReport(report: QaConfidenceReport): string {
  const lines = [
    `# OpenClaw QA Confidence Report - ${report.profile}`,
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Verdict: ${report.pass ? "pass" : "fail"}`,
    `- Strict zero unknowns: ${report.strictZeroUnknowns ? "yes" : "no"}`,
    `- Strict global pass: ${report.strictGlobalPass ? "yes" : "no"}`,
    `- Zero unknowns: ${report.zeroUnknowns ? "yes" : "no"}`,
    `- Global pass: ${report.globalPass ? "yes" : "no"}`,
    `- Counts: ${report.counts.passed} pass, ${report.counts.failed} classified fail, ${report.counts.blocked} blocked, ${report.counts.unknown} unknown`,
    "",
    "| Lane | Status | Verdict | Product impact | QA impact | Details |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const lane of report.lanes) {
    lines.push(
      `| ${escapeTableCell(lane.id)} | ${lane.status} | ${formatVerdict(lane)} | ${lane.productImpact ?? ""} | ${lane.qaImpact ?? ""} | ${escapeTableCell(lane.details)} |`,
    );
  }
  if (report.failures.length > 0) {
    lines.push(
      "",
      report.strictGlobalPass ? "## Global Gate Failures" : "## Unclassified Failures",
      "",
    );
    for (const failure of report.failures) {
      lines.push(`- ${failure}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function syntheticRuntimeCell(
  runtime: RuntimeParityCell["runtime"],
  overrides: Partial<HarnessRuntimeParityCell> = {},
): HarnessRuntimeParityCell {
  return {
    runtime,
    transcriptBytes: JSON.stringify({ message: { role: "assistant", content: "ok" } }),
    toolCalls: [],
    finalText: "ok",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    wallClockMs: 10,
    bootStateLines: [],
    ...overrides,
  };
}

function syntheticToolCall(overrides: Partial<RuntimeParityToolCall> = {}): RuntimeParityToolCall {
  return {
    tool: "openclaw.synthetic",
    argsHash: "args-a",
    resultHash: "result-a",
    ...overrides,
  };
}

async function detectRuntimeDrift(params: {
  scenarioId: string;
  openclaw: RuntimeParityCell;
  codex: RuntimeParityCell;
  expectedDrift: RuntimeParityDrift;
}): Promise<boolean> {
  const result = await runRuntimeParityScenario({
    scenarioId: params.scenarioId,
    runCell: async (runtime) => ({
      scenarioStatus: "pass",
      cell: runtime === "openclaw" ? params.openclaw : params.codex,
    }),
  });
  return result.drift === params.expectedDrift;
}

function syntheticPromptReport(
  overrides: Partial<RuntimeParitySystemPromptReport> = {},
): RuntimeParitySystemPromptReport {
  return {
    systemPrompt: {
      chars: 100,
      projectContextChars: 10,
      nonProjectContextChars: 90,
      hash: "system-prompt-a",
    },
    skills: {
      promptChars: 20,
      hash: "skills-a",
    },
    tools: {
      listChars: 30,
      schemaChars: 40,
      entries: [
        {
          name: "openclaw.synthetic",
          summaryChars: 12,
          summaryHash: "summary-a",
          schemaChars: 18,
          schemaHash: "schema-a",
          propertiesCount: 2,
        },
      ],
    },
    ...overrides,
  };
}

function detectHarnessDrift(params: {
  leftReport: RuntimeParitySystemPromptReport;
  rightReport: RuntimeParitySystemPromptReport;
  expectedDrift: HarnessParityDrift;
}): boolean {
  const left = buildHarnessParityCell({
    variant: { id: "left", label: "Left" },
    cell: syntheticRuntimeCell("openclaw", { systemPromptReport: params.leftReport }),
    tokenUsageSource: "mock-estimate",
  });
  const right = buildHarnessParityCell({
    variant: { id: "right", label: "Right" },
    cell: syntheticRuntimeCell("codex", { systemPromptReport: params.rightReport }),
    tokenUsageSource: "mock-estimate",
  });
  return (
    buildHarnessParityResult({
      scenarioId: "confidence-self-test",
      left,
      right,
    }).drift === params.expectedDrift
  );
}

function detectTokenEfficiencyRegression(): boolean {
  const openclaw = syntheticRuntimeCell("openclaw", {
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  });
  const codex = syntheticRuntimeCell("codex", {
    usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240 },
  });
  const runtimeParity: RuntimeParityResult = {
    scenarioId: "token-efficiency-regression",
    cells: { openclaw, codex },
    drift: "none",
  };
  const report = buildTokenEfficiencyReport({
    summary: {
      run: {
        providerMode: "live-frontier",
        runtimePair: ["openclaw", "codex"],
      },
      scenarios: [
        {
          name: "token-efficiency-regression",
          status: "pass",
          runtimeParity,
        },
      ],
    },
    thresholdPercent: 15,
    generatedAt: "2026-05-12T00:00:00.000Z",
  });
  return !report.pass && report.failures.length === 1;
}

function detectJsonlReplayDrift(): boolean {
  return !evaluateJsonlReplaySummary({
    transcripts: [
      {
        transcriptPath: "synthetic.jsonl",
        userTurnCount: 2,
        drift: ["none", "tool-result-shape"],
        firstDriftAtTurn: 2,
      },
    ],
  }).passed;
}

export async function buildQaConfidenceSelfTestSummary(
  generatedAt = new Date().toISOString(),
): Promise<QaConfidenceSelfTestSummary> {
  const promptDriftDetected = detectHarnessDrift({
    leftReport: syntheticPromptReport(),
    rightReport: syntheticPromptReport({
      systemPrompt: {
        chars: 100,
        projectContextChars: 10,
        nonProjectContextChars: 90,
        hash: "system-prompt-b",
      },
    }),
    expectedDrift: "system-prompt",
  });
  const toolDescriptionDetected = detectHarnessDrift({
    leftReport: syntheticPromptReport(),
    rightReport: syntheticPromptReport({
      tools: {
        listChars: 30,
        schemaChars: 40,
        entries: [
          {
            name: "openclaw.synthetic",
            summaryChars: 12,
            summaryHash: "summary-b",
            schemaChars: 18,
            schemaHash: "schema-a",
            propertiesCount: 2,
          },
        ],
      },
    }),
    expectedDrift: "tool-description",
  });
  const toolSchemaDetected = detectHarnessDrift({
    leftReport: syntheticPromptReport(),
    rightReport: syntheticPromptReport({
      tools: {
        listChars: 30,
        schemaChars: 40,
        entries: [
          {
            name: "openclaw.synthetic",
            summaryChars: 12,
            summaryHash: "summary-a",
            schemaChars: 18,
            schemaHash: "schema-b",
            propertiesCount: 2,
          },
        ],
      },
    }),
    expectedDrift: "tool-schema",
  });
  const runtimeToolCallDropDetected = await detectRuntimeDrift({
    scenarioId: "runtime-tool-call-drop",
    openclaw: syntheticRuntimeCell("openclaw", { toolCalls: [syntheticToolCall()] }),
    codex: syntheticRuntimeCell("codex", { toolCalls: [] }),
    expectedDrift: "tool-call-shape",
  });
  const toolResultMismatchDetected = await detectRuntimeDrift({
    scenarioId: "tool-result-mismatch",
    openclaw: syntheticRuntimeCell("openclaw", { toolCalls: [syntheticToolCall()] }),
    codex: syntheticRuntimeCell("codex", {
      toolCalls: [syntheticToolCall({ resultHash: "result-b" })],
    }),
    expectedDrift: "tool-result-shape",
  });
  const failureModeDriftDetected = await detectRuntimeDrift({
    scenarioId: "failure-mode-drift",
    openclaw: syntheticRuntimeCell("openclaw"),
    codex: syntheticRuntimeCell("codex", { transportErrorClass: "synthetic-transport" }),
    expectedDrift: "failure-mode",
  });
  const canaries: QaConfidenceSelfTestCanary[] = [
    {
      id: "prompt-drift",
      category: "prompt",
      detected: promptDriftDetected,
      expectedVerdict: "qa-harness-bug",
      details: "synthetic harness prompt hash changed",
    },
    {
      id: "tool-description-schema-drift",
      category: "tool-schema",
      detected: toolDescriptionDetected && toolSchemaDetected,
      expectedVerdict: "qa-harness-bug",
      details: "synthetic tool description/schema hash changed",
    },
    {
      id: "runtime-tool-call-drop",
      category: "tool-call",
      detected: runtimeToolCallDropDetected,
      expectedVerdict: "product-bug",
      details: "synthetic runtime transcript omitted a required tool call",
    },
    {
      id: "tool-result-mismatch",
      category: "tool-result",
      detected: toolResultMismatchDetected,
      expectedVerdict: "product-bug",
      details: "synthetic runtime transcript returned a mismatched tool result",
    },
    {
      id: "failure-mode-drift",
      category: "failure-mode",
      detected: failureModeDriftDetected,
      expectedVerdict: "product-bug",
      details: "synthetic runtime failed with a different failure mode",
    },
    {
      id: "token-efficiency-regression",
      category: "token-efficiency",
      detected: detectTokenEfficiencyRegression(),
      expectedVerdict: "qa-harness-bug",
      details: "synthetic token row exceeded the configured efficiency threshold",
    },
    {
      id: "jsonl-replay-ordering-drift",
      category: "jsonl-replay",
      detected: detectJsonlReplayDrift(),
      expectedVerdict: "fixture-bug",
      details: "synthetic JSONL replay drifted after turn ordering changed",
    },
  ];
  return {
    generatedAt,
    pass: canaries.every((canary) => canary.detected),
    canaries,
  };
}

export function renderQaConfidenceSelfTestMarkdownReport(
  summary: QaConfidenceSelfTestSummary,
): string {
  const lines = [
    "# OpenClaw QA Confidence Self-Test",
    "",
    `- Generated at: ${summary.generatedAt}`,
    `- Verdict: ${summary.pass ? "pass" : "fail"}`,
    "",
    "| Canary | Category | Detected | Expected verdict | Details |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const canary of summary.canaries) {
    lines.push(
      `| ${canary.id} | ${canary.category} | ${canary.detected ? "yes" : "no"} | ${canary.expectedVerdict} | ${escapeTableCell(canary.details)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function writeQaConfidenceSelfTestArtifacts(params: {
  outputDir: string;
  generatedAt?: string;
}): Promise<{ reportPath: string; summaryPath: string; summary: QaConfidenceSelfTestSummary }> {
  await fs.mkdir(params.outputDir, { recursive: true });
  const summary = await buildQaConfidenceSelfTestSummary(params.generatedAt);
  const report = renderQaConfidenceSelfTestMarkdownReport(summary);
  const reportPath = path.join(params.outputDir, "qa-confidence-self-test-report.md");
  const summaryPath = path.join(params.outputDir, "qa-confidence-self-test-summary.json");
  await fs.writeFile(reportPath, report, "utf8");
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { reportPath, summaryPath, summary };
}
