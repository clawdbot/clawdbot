import { createHash } from "node:crypto";

export const CRABBOX_GATE_CHECK_NAME = "openclaw/crabbox-gate";
const CRABBOX_GATE_TEST_ENV =
  "CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_VITEST_MAX_WORKERS=1";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function validateCrabboxGatePlan(plan) {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("Crabbox gate plan must be an object");
  }
  if (plan.version !== 1 || !SHA_PATTERN.test(plan.baseSha) || !SHA_PATTERN.test(plan.headSha)) {
    throw new Error("Crabbox gate plan must bind exact base and head SHAs");
  }
  if (!Array.isArray(plan.changedPaths) || !Array.isArray(plan.targets)) {
    throw new Error("Crabbox gate plan paths and targets must be arrays");
  }
  const changedPaths = plan.changedPaths.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !["A", "D", "M", "T"].includes(entry.status) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0
    ) {
      throw new Error("Crabbox gate plan contains an invalid changed path");
    }
    return { path: entry.path, status: entry.status };
  });
  const targets = plan.targets.map((target) => requiredString(target, "Crabbox gate test target"));
  const sortedPaths = [...changedPaths].toSorted((a, b) =>
    `${a.path}\0${a.status}`.localeCompare(`${b.path}\0${b.status}`),
  );
  const sortedTargets = [...new Set(targets)].toSorted((a, b) => a.localeCompare(b));
  if (
    JSON.stringify(changedPaths) !== JSON.stringify(sortedPaths) ||
    new Set(changedPaths.map((entry) => entry.path)).size !== changedPaths.length ||
    JSON.stringify(targets) !== JSON.stringify(sortedTargets)
  ) {
    throw new Error("Crabbox gate plan must be sorted and deduplicated");
  }
  return {
    baseSha: plan.baseSha,
    changedPaths,
    headSha: plan.headSha,
    targets,
    version: 1,
  };
}

export function crabboxGatePlanDigest(plan) {
  return createHash("sha256")
    .update(JSON.stringify(validateCrabboxGatePlan(plan)))
    .digest("hex");
}

export function buildCrabboxGateCommand(plan, bootstrapSha256) {
  const validated = validateCrabboxGatePlan(plan);
  if (!SHA256_PATTERN.test(bootstrapSha256)) {
    throw new Error("bootstrap SHA-256 must be exactly 64 lowercase hex characters");
  }
  const planDigest = crabboxGatePlanDigest(validated);
  const testCommand =
    validated.targets.length === 0
      ? "true"
      : `${CRABBOX_GATE_TEST_ENV} node --import ./scripts/tsx.mjs scripts/test-projects.mts ${validated.targets
          .map(shellQuote)
          .join(" ")}`;
  return [
    "set -euo pipefail",
    "umask 022",
    `printf '%s\\n' 'OPENCLAW_CRABBOX_GATE_VERSION=1' 'OPENCLAW_CRABBOX_GATE_MODE=remote_crabbox_aws' 'OPENCLAW_CRABBOX_GATE_BASE=${validated.baseSha}' 'OPENCLAW_CRABBOX_GATE_HEAD=${validated.headSha}' 'OPENCLAW_CRABBOX_GATE_PLAN_SHA256=${planDigest}' 'OPENCLAW_CRABBOX_GATE_TARGET_COUNT=${validated.targets.length}' 'OPENCLAW_CRABBOX_BOOTSTRAP_SHA256=${bootstrapSha256}'`,
    "printf '%s\\n' 'OPENCLAW_CRABBOX_GATE_STAGE=build:start'",
    "pnpm build",
    "printf '%s\\n' 'OPENCLAW_CRABBOX_GATE_STAGE=build:ok' 'OPENCLAW_CRABBOX_GATE_STAGE=check:start'",
    "pnpm check",
    "printf '%s\\n' 'OPENCLAW_CRABBOX_GATE_STAGE=check:ok' 'OPENCLAW_CRABBOX_GATE_STAGE=test:start'",
    testCommand,
    "printf '%s\\n' 'OPENCLAW_CRABBOX_GATE_STAGE=test:ok' 'OPENCLAW_CRABBOX_GATE_RESULT=success'",
  ].join("; ");
}

export function formatCrabboxGateCheckSummary({
  baseSha,
  headSha,
  leaseId,
  planDigest,
  runId,
  targetCount,
  workflowSha,
}) {
  if (
    !SHA_PATTERN.test(baseSha) ||
    !SHA_PATTERN.test(headSha) ||
    !SHA_PATTERN.test(workflowSha) ||
    !SHA256_PATTERN.test(planDigest) ||
    !Number.isSafeInteger(targetCount) ||
    targetCount < 0
  ) {
    throw new Error("Crabbox gate summary binding is malformed");
  }
  return `Trusted Crabbox AWS proof ${requiredString(runId, "run id")} / ${requiredString(leaseId, "lease id")}; build, check, and PR-derived tests passed for base ${baseSha}, head ${headSha}, workflow ${workflowSha}, plan ${planDigest} (${targetCount} targets).`;
}

export function parseCrabboxGateCheckSummary(summary) {
  const match = requiredString(summary, "Crabbox gate check summary").match(
    /^Trusted Crabbox AWS proof (run_[a-z0-9]+) \/ (cbx_[a-z0-9]+); build, check, and PR-derived tests passed for base ([0-9a-f]{40}), head ([0-9a-f]{40}), workflow ([0-9a-f]{40}), plan ([0-9a-f]{64}) \((\d+) targets\)\.$/u,
  );
  if (!match) {
    throw new Error("openclaw/crabbox-gate summary binding is malformed");
  }
  const targetCount = Number(match[7]);
  const binding = {
    baseSha: match[3],
    headSha: match[4],
    leaseId: match[2],
    planDigest: match[6],
    runId: match[1],
    targetCount,
    workflowSha: match[5],
  };
  if (formatCrabboxGateCheckSummary(binding) !== summary) {
    throw new Error("openclaw/crabbox-gate summary binding is not canonical");
  }
  return binding;
}

export function validateForwardAncestry(comparisonValue, { baseSha, headSha }, label) {
  const ancestryLabel = requiredString(label, "ancestry label");
  if (
    !SHA_PATTERN.test(baseSha) ||
    !SHA_PATTERN.test(headSha) ||
    comparisonValue === null ||
    typeof comparisonValue !== "object" ||
    Array.isArray(comparisonValue)
  ) {
    throw new Error(`${ancestryLabel} is malformed`);
  }
  const comparison = comparisonValue;
  const aheadBy = comparison.ahead_by;
  const behindBy = comparison.behind_by;
  const validCounts =
    Number.isSafeInteger(aheadBy) &&
    aheadBy >= 0 &&
    Number.isSafeInteger(behindBy) &&
    behindBy === 0;
  const validStatus =
    baseSha === headSha
      ? comparison.status === "identical" && aheadBy === 0
      : comparison.status === "ahead" && aheadBy >= 1;
  if (
    comparison.base_commit?.sha !== baseSha ||
    comparison.merge_base_commit?.sha !== baseSha ||
    !validCounts ||
    !validStatus
  ) {
    throw new Error(`${ancestryLabel} is not identical or forward`);
  }
  return { baseSha, headSha };
}

export function isProtectedMainWorkflowPath(value, workflowPath) {
  return value === workflowPath || value === `${workflowPath}@refs/heads/main`;
}
