#!/usr/bin/env node
// Binds Full Release Validation run metadata to its v3 evidence manifest.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FULL_RELEASE_WORKFLOW = "Full Release Validation";
const FULL_RELEASE_WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const PINNED_BRANCH_PATTERN = /^release-ci\/([a-f0-9]{12})-([1-9][0-9]*)$/u;

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

export function validateFullReleaseValidationEvidence({
  run: rawRun,
  manifest,
  expectedRepository,
  expectedRunId,
  expectedTargetSha,
  expectedWorkflowBranch,
  isTrustedMainAncestor,
  validateEvidenceReuseStrictly,
}) {
  const run = normalizeFullReleaseValidationRun(rawRun);
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

  if (manifest.version !== 3) {
    throw new Error(
      `Full release validation manifest must use version 3, got ${manifest.version}.`,
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
    if (String(manifest[key] ?? "") !== expected) {
      throw new Error(
        `Full release validation manifest ${key} mismatch: expected ${expected}, got ${manifest[key] ?? "<missing>"}.`,
      );
    }
  }

  const pinnedMatch = PINNED_BRANCH_PATTERN.exec(run.headBranch ?? "");
  if (!pinnedMatch) {
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
      return { run, source: "direct" };
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
      `SHA-pinned validation target ref mismatch: expected ${expectedTargetSha}, got ${manifest.targetRef ?? "<missing>"}.`,
    );
  }
  if (!isTrustedMainAncestor?.(run.headSha)) {
    throw new Error(
      `SHA-pinned validation workflow ${run.headSha} is not reachable from current main.`,
    );
  }
  if (Object.hasOwn(manifest, "evidenceReuse")) {
    const reuse = manifest.evidenceReuse;
    if (
      !reuse ||
      typeof reuse !== "object" ||
      Array.isArray(reuse) ||
      reuse.policy !== "exact-target-full-validation-v1" ||
      reuse.evidenceSha !== expectedTargetSha ||
      !Array.isArray(reuse.changedPaths) ||
      reuse.changedPaths.length !== 0 ||
      !/^[1-9][0-9]*$/u.test(String(reuse.runId ?? "")) ||
      !/^[1-9][0-9]*$/u.test(String(reuse.selectedRunId ?? ""))
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
      strictEvidence?.schema !== "openclaw.release-validation-evidence/v3" ||
      strictEvidence.valid !== true ||
      String(strictEvidence.current?.runId ?? "") !== String(expectedRunId) ||
      strictEvidence.current?.targetSha !== expectedTargetSha ||
      strictEvidence.root?.targetSha !== expectedTargetSha ||
      strictEvidence.evidenceReuse?.evidenceSha !== expectedTargetSha ||
      String(strictEvidence.evidenceReuse?.rootRunId ?? "") !== String(reuse.runId) ||
      String(strictEvidence.evidenceReuse?.selectedRunId ?? "") !== String(reuse.selectedRunId) ||
      strictEvidence.conclusions?.allRequiredSucceeded !== true
    ) {
      throw new Error("SHA-pinned validation evidence reuse failed strict chain validation.");
    }
  }
  return { run, source: "sha-pinned-main" };
}

export function runStrictReleaseEvidenceValidation({
  repository,
  runId,
  validatorFile = fileURLToPath(new URL("./release-ci-summary.mjs", import.meta.url)),
  verifierSourceSha,
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
      "main",
      "--json",
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
    expectedWorkflowBranch: process.env.EXPECTED_WORKFLOW_BRANCH,
    isTrustedMainAncestor: (sha) => gitIsAncestor(sha, trustedMainRef),
    validateEvidenceReuseStrictly: ({ repository, runId }) =>
      runStrictReleaseEvidenceValidation({
        repository,
        runId,
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
