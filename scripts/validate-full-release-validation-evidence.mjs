#!/usr/bin/env node
// Binds Full Release Validation run metadata to its supported evidence manifest.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeReleaseCoveragePolicy } from "./full-release-validation-policy.mjs";
import { resolveReleaseContextIdentity } from "./lib/release-context.mjs";

const FULL_RELEASE_WORKFLOW = "Full Release Validation";
const FULL_RELEASE_WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const PINNED_BRANCH_PATTERN = /^release-ci\/([a-f0-9]{12})-([1-9][0-9]*)$/u;
const TRUSTED_RELEASE_PUBLISH_TAG_PATTERN =
  /^refs\/tags\/release-publish\/([a-f0-9]{12})-[1-9][0-9]*$/u;
const EXACT_TARGET_EVIDENCE_REUSE_POLICY = "exact-target-full-validation-v1";
const CHANGELOG_ONLY_EVIDENCE_REUSE_POLICY = "changelog-only-release-v1";

/** @param {unknown} value */
function scalarString(value) {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return "";
}

/** @param {unknown} value */
function displayValue(value) {
  if (value === null || value === undefined) {
    return "<missing>";
  }
  const scalar = scalarString(value);
  if (scalar) {
    return scalar;
  }
  try {
    return JSON.stringify(value) ?? "<unserializable>";
  } catch {
    return "<unserializable>";
  }
}

/**
 * @typedef {object} StrictReleaseEvidence
 * @property {unknown} [schema]
 * @property {unknown} [valid]
 * @property {{ runId?: unknown, targetSha?: unknown }} [current]
 * @property {{ runId?: unknown, targetSha?: unknown }} [root]
 * @property {{ changedPaths?: unknown, evidenceSha?: unknown, policy?: unknown, rootRunId?: unknown, selectedRunId?: unknown }} [evidenceReuse]
 * @property {{ allRequiredSucceeded?: unknown }} [conclusions]
 */
/**
 * @typedef {object} FullReleaseValidationManifest
 * @property {unknown} [version]
 * @property {unknown} [workflowName]
 * @property {unknown} [runId]
 * @property {unknown} [runAttempt]
 * @property {unknown} [workflowRef]
 * @property {unknown} [workflowSha]
 * @property {unknown} [workflowFullRef]
 * @property {unknown} [workflowRefType]
 * @property {unknown} [targetRef]
 * @property {unknown} [targetSha]
 * @property {unknown} [releaseProfile]
 * @property {unknown} [rerunGroup]
 * @property {unknown} [runReleaseSoak]
 * @property {{ package?: { version?: unknown } }} [candidateBinding]
 * @property {{ coveragePolicy?: unknown, targetVersion?: unknown, targetContextRef?: unknown }} [validationInputs]
 * @property {{ changedPaths?: unknown, evidenceSha?: unknown, policy?: unknown, runId?: unknown, selectedRunId?: unknown }} [evidenceReuse]
 */
/**
 * @typedef {object} FullReleaseValidationEvidenceOptions
 * @property {unknown} run
 * @property {FullReleaseValidationManifest} manifest
 * @property {string} expectedRepository
 * @property {string | number} expectedRunId
 * @property {string} expectedTargetSha
 * @property {string} [expectedReleaseTag]
 * @property {string} [expectedTrustedWorkflowFullRef]
 * @property {string} [expectedTrustedWorkflowSha]
 * @property {string} [expectedWorkflowBranch]
 * @property {(sha: string) => boolean} [isTrustedMainAncestor]
 * @property {(params: { repository: string, runId: string, targetSha: string }) => StrictReleaseEvidence} [validateEvidenceReuseStrictly]
 */

function normalizeWorkflowPathRef(ref) {
  if (!ref || ref.startsWith("refs/")) {
    return ref;
  }
  return `refs/heads/${ref}`;
}

export function normalizeFullReleaseValidationRun(run) {
  const [workflowPath, workflowQualifiedRef] = String(run.path ?? run.workflowPath ?? "").split(
    "@",
    2,
  );
  return {
    databaseId: String(run.id ?? run.databaseId ?? ""),
    runAttempt: Number(run.run_attempt ?? run.runAttempt ?? run.attempt),
    workflowName: run.name ?? run.workflowName,
    workflowPath,
    workflowQualifiedRef,
    repository: run.repository?.full_name ?? run.repository,
    headBranch: run.head_branch ?? run.headBranch,
    headSha: run.head_sha ?? run.headSha,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url ?? run.url,
  };
}

export function isShaPinnedReleaseValidationBranch(branch) {
  return PINNED_BRANCH_PATTERN.test(branch ?? "");
}

/** @param {FullReleaseValidationEvidenceOptions} options */
export function validateFullReleaseValidationEvidence({
  run: rawRun,
  manifest,
  expectedRepository,
  expectedRunId,
  expectedTargetSha,
  expectedReleaseTag,
  expectedTrustedWorkflowFullRef,
  expectedTrustedWorkflowSha,
  expectedWorkflowBranch,
  isTrustedMainAncestor,
  validateEvidenceReuseStrictly,
}) {
  const run = normalizeFullReleaseValidationRun(rawRun);
  const trustedWorkflowFullRef = expectedTrustedWorkflowFullRef ?? "refs/heads/main";
  const protectedTag = TRUSTED_RELEASE_PUBLISH_TAG_PATTERN.exec(trustedWorkflowFullRef);
  if (protectedTag) {
    if (!SHA_PATTERN.test(expectedTrustedWorkflowSha ?? "")) {
      throw new Error("Protected release-publish evidence requires an exact trusted workflow SHA.");
    }
    if (expectedTrustedWorkflowSha.slice(0, 12) !== protectedTag[1]) {
      throw new Error("Protected release-publish tag does not match its trusted workflow SHA.");
    }
  } else if (
    !trustedWorkflowFullRef.startsWith("refs/heads/") ||
    trustedWorkflowFullRef.startsWith("refs/heads/release-publish/")
  ) {
    throw new Error("Trusted release-publish workflow ref must be an exact protected tag.");
  }
  const checks = [
    ["databaseId", String(expectedRunId)],
    ["workflowName", FULL_RELEASE_WORKFLOW],
    ["workflowPath", FULL_RELEASE_WORKFLOW_PATH],
    ["repository", expectedRepository],
    ["event", "workflow_dispatch"],
    ["status", "completed"],
    ["conclusion", "success"],
  ];
  for (const [key, expected] of checks) {
    if (run[key] !== expected) {
      throw new Error(
        `Referenced full release validation run ${expectedRunId} must have ${key}=${expected}, got ${run[key] ?? "<missing>"}.`,
      );
    }
  }
  if (!Number.isInteger(run.runAttempt) || run.runAttempt < 1) {
    throw new Error(`Referenced full release validation run ${expectedRunId} has invalid attempt.`);
  }
  if (!SHA_PATTERN.test(run.headSha ?? "")) {
    throw new Error(
      `Referenced full release validation run ${expectedRunId} has invalid head SHA.`,
    );
  }
  const expectedQualifiedRef = `refs/heads/${run.headBranch}`;
  const workflowQualifiedRef = normalizeWorkflowPathRef(run.workflowQualifiedRef);
  if (workflowQualifiedRef && workflowQualifiedRef !== expectedQualifiedRef) {
    throw new Error(
      `Referenced full release validation run ${expectedRunId} has workflow path ref ${run.workflowQualifiedRef}, expected ${expectedQualifiedRef}.`,
    );
  }

  if (manifest.version !== 3 && manifest.version !== 4) {
    throw new Error(
      `Full release validation manifest must use version 3 or 4, got ${displayValue(manifest.version)}.`,
    );
  }
  const coveragePolicy = normalizeReleaseCoveragePolicy({
    ...manifest.validationInputs,
    candidateVersion: manifest.candidateBinding?.package?.version,
    releaseProfile: manifest.releaseProfile,
    rerunGroup: manifest.rerunGroup,
    runReleaseSoak: manifest.runReleaseSoak,
  });
  const coveredReleaseTag =
    coveragePolicy === "npm-stable-v1"
      ? resolveReleaseContextIdentity(
          scalarString(manifest.validationInputs?.targetContextRef) ||
            scalarString(manifest.targetRef),
          scalarString(manifest.validationInputs?.targetVersion),
        )?.releaseTag
      : `v${scalarString(manifest.validationInputs?.targetVersion)}`;
  if (
    coveragePolicy &&
    (manifest.version !== 4 || !coveredReleaseTag || expectedReleaseTag !== coveredReleaseTag)
  ) {
    throw new Error(
      "Release coverage policy requires version 4 evidence for the exact publication tag.",
    );
  }
  const manifestChecks = [
    ["workflowName", FULL_RELEASE_WORKFLOW],
    ["runId", String(expectedRunId)],
    ["runAttempt", String(run.runAttempt)],
    ["workflowRef", run.headBranch],
    ["workflowSha", run.headSha],
    ["workflowFullRef", expectedQualifiedRef],
    ["workflowRefType", "branch"],
    ["targetSha", expectedTargetSha],
  ];
  for (const [key, expected] of manifestChecks) {
    if (scalarString(manifest[key]) !== expected) {
      throw new Error(
        `Full release validation manifest ${key} mismatch: expected ${expected}, got ${displayValue(manifest[key])}.`,
      );
    }
  }

  const pinnedMatch = PINNED_BRANCH_PATTERN.exec(run.headBranch ?? "");
  if (!pinnedMatch) {
    if (protectedTag) {
      throw new Error(
        "Protected-tag release evidence must use a canonical release-ci producer branch.",
      );
    }
    if (run.headBranch?.startsWith("release-ci/")) {
      throw new Error(
        `Referenced full release validation run ${expectedRunId} has untrusted head branch ${run.headBranch}.`,
      );
    }
    const directBranches = new Set(["main", expectedWorkflowBranch].filter(Boolean));
    if (directBranches.has(run.headBranch)) {
      if (run.headBranch === "main" && !isTrustedMainAncestor?.(run.headSha)) {
        throw new Error(
          `Direct main validation workflow ${run.headSha} is not reachable from current main.`,
        );
      }
      return { run, source: "direct", coveragePolicy };
    }
    throw new Error(
      `Referenced full release validation run ${expectedRunId} has untrusted head branch ${run.headBranch ?? "<missing>"}.`,
    );
  }
  if (pinnedMatch[1] !== run.headSha.slice(0, 12)) {
    throw new Error(
      `SHA-pinned validation branch ${run.headBranch} does not match workflow SHA ${run.headSha}.`,
    );
  }
  if (manifest.targetRef !== expectedTargetSha) {
    throw new Error(
      `SHA-pinned validation target ref mismatch: expected ${expectedTargetSha}, got ${displayValue(manifest.targetRef)}.`,
    );
  }
  // The protected tag authenticates the current publisher. An older validation
  // producer remains trusted only through its independent current-main lineage.
  const historicalProtectedProducer = protectedTag && run.headSha !== expectedTrustedWorkflowSha;
  if ((historicalProtectedProducer || !protectedTag) && !isTrustedMainAncestor?.(run.headSha)) {
    const subject = protectedTag
      ? "Protected-tag release evidence workflow SHA"
      : "SHA-pinned validation workflow";
    throw new Error(`${subject} ${run.headSha} is not reachable from current main.`);
  }
  const source = protectedTag
    ? historicalProtectedProducer
      ? "sha-pinned-protected-tag-main-ancestor"
      : "sha-pinned-protected-tag"
    : "sha-pinned-main";
  if (Object.hasOwn(manifest, "evidenceReuse")) {
    const reuse = manifest.evidenceReuse;
    const exactTarget =
      reuse?.policy === EXACT_TARGET_EVIDENCE_REUSE_POLICY &&
      reuse.evidenceSha === expectedTargetSha &&
      Array.isArray(reuse.changedPaths) &&
      reuse.changedPaths.length === 0;
    const changelogOnly =
      reuse?.policy === CHANGELOG_ONLY_EVIDENCE_REUSE_POLICY &&
      reuse.evidenceSha !== expectedTargetSha &&
      Array.isArray(reuse.changedPaths) &&
      reuse.changedPaths.length === 1 &&
      reuse.changedPaths[0] === "CHANGELOG.md";
    if (
      !reuse ||
      typeof reuse !== "object" ||
      Array.isArray(reuse) ||
      (!exactTarget && !changelogOnly) ||
      !/^[1-9][0-9]*$/u.test(scalarString(reuse.runId)) ||
      !/^[1-9][0-9]*$/u.test(scalarString(reuse.selectedRunId))
    ) {
      throw new Error("SHA-pinned validation evidence reuse is invalid.");
    }
    if (typeof validateEvidenceReuseStrictly !== "function") {
      throw new Error("SHA-pinned validation evidence reuse requires strict chain validation.");
    }
    const strictEvidence = validateEvidenceReuseStrictly({
      repository: expectedRepository,
      runId: String(expectedRunId),
      targetSha: expectedTargetSha,
    });
    if (
      strictEvidence?.schema !== `openclaw.release-validation-evidence/v${manifest.version}` ||
      strictEvidence.valid !== true ||
      scalarString(strictEvidence.current?.runId) !== String(expectedRunId) ||
      strictEvidence.current?.targetSha !== expectedTargetSha ||
      strictEvidence.root?.targetSha !== reuse.evidenceSha ||
      strictEvidence.evidenceReuse?.evidenceSha !== reuse.evidenceSha ||
      strictEvidence.evidenceReuse?.policy !== reuse.policy ||
      JSON.stringify(strictEvidence.evidenceReuse?.changedPaths) !==
        JSON.stringify(reuse.changedPaths) ||
      scalarString(strictEvidence.evidenceReuse?.rootRunId) !== scalarString(reuse.runId) ||
      scalarString(strictEvidence.evidenceReuse?.selectedRunId) !==
        scalarString(reuse.selectedRunId) ||
      strictEvidence.conclusions?.allRequiredSucceeded !== true
    ) {
      throw new Error("SHA-pinned validation evidence reuse failed strict chain validation.");
    }
  }
  return { run, source, coveragePolicy };
}

/**
 * @param {{
 *   repository: string;
 *   runId: string | number;
 *   validatorFile?: string;
 *   verifierSourceSha?: string;
 *   trustedWorkflowFullRef?: string;
 *   trustedWorkflowRef?: string;
 *   trustedWorkflowSha?: string;
 * }} params
 */
export function runStrictReleaseEvidenceValidation({
  repository,
  runId,
  validatorFile = fileURLToPath(new URL("./release-ci-summary.mjs", import.meta.url)),
  verifierSourceSha,
  trustedWorkflowFullRef = "refs/heads/main",
  trustedWorkflowRef = "main",
  trustedWorkflowSha,
}) {
  const verifierSourceArgs = verifierSourceSha
    ? ["--verifier-source-sha", verifierSourceSha, "--verifier-source-file", validatorFile]
    : [];
  const result = spawnSync(
    process.execPath,
    [
      validatorFile,
      "--validate-run",
      String(runId),
      "--repo",
      repository,
      "--trusted-workflow-ref",
      trustedWorkflowRef,
      "--trusted-workflow-full-ref",
      trustedWorkflowFullRef,
      "--json",
      ...(trustedWorkflowSha ? ["--trusted-workflow-sha", trustedWorkflowSha] : []),
      ...verifierSourceArgs,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(
      `Strict release evidence validation failed: ${result.stderr?.trim() || result.signal || result.status}.`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Strict release evidence validator returned invalid JSON.");
  }
}

function gitIsAncestor(ancestor, target) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", `${ancestor}^{commit}`, `${target}^{commit}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  throw new Error(
    `Could not validate trusted workflow ancestry: ${result.stderr?.trim() || result.signal || result.status}.`,
  );
}

function main() {
  const manifestPath = process.env.MANIFEST_FILE ?? "";
  if (!manifestPath) {
    throw new Error("MANIFEST_FILE is required.");
  }
  const run = JSON.parse(readFileSync(0, "utf8"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const trustedMainRef = process.env.TRUSTED_MAIN_REF ?? "refs/remotes/origin/main";
  const result = validateFullReleaseValidationEvidence({
    run,
    manifest,
    expectedRepository: process.env.GITHUB_REPOSITORY,
    expectedRunId: process.env.FULL_RELEASE_VALIDATION_RUN_ID,
    expectedTargetSha: process.env.EXPECTED_SHA,
    expectedReleaseTag: process.env.RELEASE_TAG,
    expectedTrustedWorkflowFullRef: process.env.TRUSTED_WORKFLOW_FULL_REF,
    expectedTrustedWorkflowSha: process.env.TRUSTED_WORKFLOW_SHA,
    expectedWorkflowBranch: process.env.EXPECTED_WORKFLOW_BRANCH,
    isTrustedMainAncestor: (sha) => gitIsAncestor(sha, trustedMainRef),
    validateEvidenceReuseStrictly: ({ repository, runId }) =>
      runStrictReleaseEvidenceValidation({
        repository,
        runId,
        trustedWorkflowFullRef: process.env.TRUSTED_WORKFLOW_FULL_REF,
        trustedWorkflowRef: process.env.TRUSTED_WORKFLOW_REF,
        trustedWorkflowSha: process.env.TRUSTED_WORKFLOW_SHA,
        validatorFile:
          process.env.STRICT_VALIDATOR_FILE ??
          fileURLToPath(new URL("./release-ci-summary.mjs", import.meta.url)),
        verifierSourceSha: process.env.GITHUB_SHA,
      }),
  });
  console.log(
    `Using full release validation run ${result.run.databaseId} (${result.source}): ${result.run.url}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
