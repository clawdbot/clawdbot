#!/usr/bin/env node
// Dispatches full release validation against a temporary SHA-pinned branch.
import {
  execFileSync,
  spawnSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { isRecord as isJsonRecord } from "../packages/normalization-core/src/record-coerce.ts";
import {
  classifyReleaseGhTransportError,
  formatReleaseStateOutcome,
  isReleaseGhArtifactMissingError,
  validateReleaseStateArtifact,
} from "./full-release-validation-policy.mjs";
import { execGhRead } from "./lib/plain-gh.mjs";

const WORKFLOW = "full-release-validation.yml";
const TRUSTED_WORKFLOW_PATH = `.github/workflows/${WORKFLOW}`;
const RELEASE_ISOLATION_TOOLING_CONTRACT = "2";
const RELEASE_ISOLATION_TOOLING_CONTRACT_ENV = "RELEASE_ISOLATION_TOOLING_CONTRACT";
const RELEASE_EVIDENCE_VERIFIER_PATHS = [
  "scripts/release-ci-summary.mjs",
  ".agents/skills/release-openclaw-ci/scripts/release-ci-summary.mjs",
];
const GH_READ_TIMEOUT_MS = 60_000;
export const FULL_RELEASE_WAIT_TIMEOUT_MINUTES = 720;
export const FULL_RELEASE_GITHUB_POLL_INTERVAL_MS = 15 * 60_000;
const FULL_RELEASE_RUN_DISCOVERY_ATTEMPTS = 2;
const RELEASE_DECISION_FILE = "full-release-decision.json";
const MAX_RELEASE_DECISION_BYTES = 128 * 1024;
const GH_READ_OPTIONS = {
  encoding: "utf8",
  killSignal: "SIGKILL",
  stdio: ["ignore", "pipe", "inherit"],
  timeout: GH_READ_TIMEOUT_MS,
} satisfies ExecFileSyncOptionsWithStringEncoding;
const RELEASE_BRANCH_PATTERN = /^release\/([0-9]{4}\.(?:[1-9]|1[0-2])\.[1-9][0-9]*)$/u;
const EXTENDED_STABLE_BRANCH_PATTERN = /^extended-stable\/([0-9]{4}\.(?:[1-9]|1[0-2])\.33)$/u;
const RELEASE_CONTEXT_BRANCH_PATTERN =
  /^(?:release\/[0-9]{4}\.(?:[1-9]|1[0-2])\.[1-9][0-9]*|extended-stable\/[0-9]{4}\.(?:[1-9]|1[0-2])\.33)$/u;
const RELEASE_TAG_PATTERN =
  /^v([0-9]{4}\.(?:[1-9]|1[0-2])\.[1-9][0-9]*(?:-(?:alpha|beta)\.[1-9][0-9]*)?)$/u;
const TRUSTED_WORKFLOW_TAG_PATTERN = /^release-publish\/([a-f0-9]{12})-[1-9][0-9]*$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const RERUN_GROUPS = new Set([
  "all",
  "ci",
  "plugin-prerelease",
  "install-smoke",
  "cross-os",
  "live-e2e",
  "package",
  "qa-parity",
  "qa-live",
  "npm-telegram",
  "performance",
]);
const DEFAULT_INPUTS = {
  provider: "openai",
  mode: "both",
  rerun_group: "all",
  reuse_evidence: "true",
  fail_fast: "false",
};

type ReleaseInputs = Record<string, string> &
  typeof DEFAULT_INPUTS &
  Partial<Record<"release_profile" | "allow_unreleased_changelog", string>>;
type CommandOptions = {
  dryRun?: boolean;
  stdio?: "inherit" | ["ignore", "pipe" | "ignore", "pipe" | "inherit" | "ignore"];
  timeoutMs?: number;
};
type CommandStatus = {
  error?: Error;
  signal?: unknown;
  status: number | null;
  stderr: unknown;
  stdout: unknown;
};
type TemporaryRefParams = {
  keepBranch: boolean;
  dryRun: boolean;
  parentConclusion: string;
  evidenceVerified: boolean;
};
type TrustedWorkflowHarness = {
  contract: "1" | "2";
  verifierPath: string;
};

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function displayValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return value === null ? "null" : (JSON.stringify(value) ?? "<undefined>");
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return normalized;
}

function usage() {
  console.error(`Usage: node scripts/full-release-validation-at-sha.mjs [--sha <target-sha>] [--target-ref <canonical-release-branch-or-tag>] [--workflow-sha <trusted-tooling-sha>] [--trusted-workflow-ref <main-or-release-publish-tag>] [--keep-branch] [--dry-run] [-- -f key=value ...]

Creates temporary remote branches pinned to the exact Tooling SHA and Validation SHA,
dispatches Full Release Validation with the full Validation SHA as its ref input
and expected_sha as its immutable identity,
watches the parent run, verifies all child workflow head SHAs match the trusted
workflow lineage through the release evidence manifest, then deletes both
temporary branches by default. --keep-branch retains both branches. Exact-target and changelog-only Release SHA
evidence reuse stay enabled; pass -f reuse_evidence=false to force a fresh
run. Child workflows collect independent failures by default; pass
-f fail_fast=true to cancel only an exact still-active child after Release
Decision identifies a blocking failure for that child. The release
branch accepts only its final package version or a matching beta prerelease.
Exact alpha tags remain supported for Tideclaw. The release profile defaults to
beta for beta candidates and exact alpha tags, and stable otherwise; pass
-f release_profile=full for the broad advisory sweep. Focused retries must use
one controller rerun_group; the removed release-checks aggregate and the direct
child's manual qa aggregate are not accepted.`);
}

function run(command: string, args: string[], options: CommandOptions = {}) {
  if (options.dryRun) {
    console.log(["+", command, ...args].join(" "));
    return "";
  }
  const output = execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "inherit"],
  });
  return typeof output === "string" ? output.trim() : "";
}

function runStatus(command: string, args: string[], options: CommandOptions = {}) {
  if (options.dryRun) {
    console.log(["+", command, ...args].join(" "));
    return { status: 0, stderr: "", stdout: "" };
  }
  return spawnSync(command, args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    stdio: options.stdio ?? ["ignore", "pipe", "inherit"],
    timeout: options.timeoutMs ?? GH_READ_TIMEOUT_MS,
  });
}

function readOptionValue(argv: string[], index: number, optionName: string): string {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

export function parseArgs(argv: string[]) {
  const inputs: ReleaseInputs = { ...DEFAULT_INPUTS };
  const args = {
    sha: "",
    targetRef: "",
    trustedWorkflowRef: "main",
    workflowSha: "",
    keepBranch: false,
    dryRun: false,
    inputs,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--sha") {
      args.sha = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--workflow-sha") {
      args.workflowSha = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--trusted-workflow-ref") {
      args.trustedWorkflowRef = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--target-ref") {
      args.targetRef = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--keep-branch") {
      args.keepBranch = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--") {
      const extras = argv.slice(i + 1);
      for (let extraIndex = 0; extraIndex < extras.length; extraIndex += 1) {
        const extra = extras[extraIndex]!;
        let assignment;
        if (extra === "-f") {
          assignment = readOptionValue(extras, extraIndex, extra);
          extraIndex += 1;
        } else {
          assignment = extra.startsWith("-f") ? extra.slice(2).trim() : extra;
        }
        const [key, ...valueParts] = assignment.split("=");
        if (!key || valueParts.length === 0) {
          throw new Error(`Unsupported extra argument after --: ${extra}`);
        }
        args.inputs[key] = valueParts.join("=");
      }
      break;
    }
    if (arg === "-f") {
      const assignment = readOptionValue(argv, i, arg);
      i += 1;
      const [key, ...valueParts] = assignment.split("=");
      if (!key || valueParts.length === 0) {
        throw new Error(`Invalid -f assignment: ${assignment}`);
      }
      args.inputs[key] = valueParts.join("=");
      continue;
    }
    if (arg.startsWith("-f") && arg.includes("=")) {
      const assignment = arg.slice(2).trim();
      const [key, ...valueParts] = assignment.split("=");
      if (!key || valueParts.length === 0) {
        throw new Error(`Invalid -f assignment: ${arg}`);
      }
      args.inputs[key] = valueParts.join("=");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!["true", "false"].includes(args.inputs.reuse_evidence)) {
    throw new Error("reuse_evidence must be true or false");
  }
  if (!["true", "false"].includes(args.inputs.fail_fast)) {
    throw new Error("fail_fast must be true or false");
  }
  if (
    Object.hasOwn(args.inputs, "allow_unreleased_changelog") &&
    !["true", "false"].includes(args.inputs.allow_unreleased_changelog ?? "")
  ) {
    throw new Error("allow_unreleased_changelog must be true or false");
  }
  if (
    args.inputs.release_profile &&
    !["beta", "stable", "full"].includes(args.inputs.release_profile)
  ) {
    throw new Error("release_profile must be beta, stable, or full");
  }
  if (!RERUN_GROUPS.has(args.inputs.rerun_group)) {
    throw new Error(`rerun_group must be one of: ${[...RERUN_GROUPS].join(", ")}`);
  }
  if (Object.hasOwn(args.inputs, "ref")) {
    throw new Error("SHA-pinned release validation reserves the ref input for --sha");
  }
  if (Object.hasOwn(args.inputs, "expected_sha")) {
    throw new Error("SHA-pinned release validation reserves expected_sha for the resolved --sha");
  }
  if (Object.hasOwn(args.inputs, "trusted_workflow_json")) {
    throw new Error("SHA-pinned release validation reserves trusted_workflow_json");
  }
  if (
    args.targetRef &&
    !RELEASE_CONTEXT_BRANCH_PATTERN.test(args.targetRef) &&
    !RELEASE_TAG_PATTERN.test(args.targetRef)
  ) {
    throw new Error("--target-ref must be a canonical OpenClaw release branch or tag");
  }
  if (
    args.trustedWorkflowRef !== "main" &&
    !TRUSTED_WORKFLOW_TAG_PATTERN.test(args.trustedWorkflowRef)
  ) {
    throw new Error(
      "--trusted-workflow-ref must be main or a protected release-publish/<12hex>-<decimal> tag",
    );
  }
  if (args.trustedWorkflowRef !== "main" && !SHA_PATTERN.test(args.workflowSha.toLowerCase())) {
    throw new Error(
      "protected release-publish workflow refs require --workflow-sha with an explicit full Tooling SHA",
    );
  }
  if (
    RELEASE_CONTEXT_BRANCH_PATTERN.test(args.targetRef) &&
    !SHA_PATTERN.test(args.workflowSha.toLowerCase())
  ) {
    throw new Error(
      "release-branch validation requires --workflow-sha with an explicit full Tooling SHA",
    );
  }
  return args;
}

export function resolveRemoteTargetRefSha(
  targetRef: string,
  executeGit: (args: string[]) => string = (args) => run("git", args),
) {
  if (RELEASE_CONTEXT_BRANCH_PATTERN.test(targetRef)) {
    return (
      executeGit(["ls-remote", "--heads", "origin", `refs/heads/${targetRef}`]).split(/\s+/u)[0] ??
      ""
    );
  }

  const tagRef = `refs/tags/${targetRef}`;
  const peeledSha = executeGit(["ls-remote", "--tags", "origin", `${tagRef}^{}`]).split(/\s+/u)[0];
  if (peeledSha) {
    return peeledSha;
  }
  return executeGit(["ls-remote", "--tags", "origin", tagRef]).split(/\s+/u)[0] ?? "";
}

export function verifyTargetRef(
  targetRef: string,
  targetSha: string,
  targetVersion: string,
  resolveRemoteSha: (ref: string) => string = resolveRemoteTargetRefSha,
  isAncestor: (ancestor: string, descendant: string) => boolean = (ancestor, descendant) =>
    runStatus("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: ["ignore", "ignore", "ignore"],
    }).status === 0,
) {
  if (!targetRef) {
    return targetSha;
  }
  const releaseMatch = targetRef.match(RELEASE_BRANCH_PATTERN);
  const extendedStableMatch = targetRef.match(EXTENDED_STABLE_BRANCH_PATTERN);
  const tagMatch = targetRef.match(RELEASE_TAG_PATTERN);
  if (releaseMatch) {
    const releaseVersion = releaseMatch[1]!;
    const prereleaseMatch = targetVersion.match(
      /^([0-9]{4}\.(?:[1-9]|1[0-2])\.[1-9][0-9]*)-beta\.[1-9][0-9]*$/u,
    );
    if (targetVersion !== releaseVersion && prereleaseMatch?.[1] !== releaseVersion) {
      throw new Error(
        `Target package version ${targetVersion} does not belong to release branch ${targetRef}; expected ${releaseVersion} or a beta prerelease of it`,
      );
    }
  } else if (extendedStableMatch) {
    if (targetVersion !== extendedStableMatch[1]) {
      throw new Error(
        `Target package version ${targetVersion} does not match extended-stable branch ${targetRef}`,
      );
    }
  } else if (tagMatch && targetVersion !== tagMatch[1]) {
    throw new Error(
      `Target package version ${targetVersion} does not match release tag ${targetRef}`,
    );
  }
  const remoteSha = resolveRemoteSha(targetRef);
  if (!remoteSha) {
    throw new Error(`Target ref ${targetRef} does not resolve to a commit`);
  }
  if (RELEASE_CONTEXT_BRANCH_PATTERN.test(targetRef)) {
    if (!isAncestor(targetSha, remoteSha)) {
      throw new Error(
        `Target SHA ${targetSha} is not reachable from release branch ${targetRef} at ${remoteSha}`,
      );
    }
    return targetRef;
  }
  if (remoteSha.toLowerCase() !== targetSha.toLowerCase()) {
    throw new Error(`Target ref ${targetRef} does not resolve to ${targetSha}`);
  }
  return targetRef;
}

function resolveSha(requestedSha: string) {
  const rev = requestedSha || "HEAD";
  return run("git", ["rev-parse", "--verify", `${rev}^{commit}`], { dryRun: false });
}

function fetchTargetRef(targetRef: string) {
  if (!targetRef) {
    return;
  }
  const sourceRef = RELEASE_CONTEXT_BRANCH_PATTERN.test(targetRef)
    ? `refs/heads/${targetRef}`
    : `refs/tags/${targetRef}`;
  run("git", ["fetch", "--no-tags", "origin", sourceRef], {
    stdio: "inherit",
  });
}

function resolveTargetSha(requestedSha: string, targetRef: string) {
  fetchTargetRef(targetRef);
  const revision = requestedSha || "HEAD";
  const resolved = runStatus("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const resolvedSha = typeof resolved.stdout === "string" ? resolved.stdout.trim() : "";
  if (resolved.status !== 0 || !resolvedSha) {
    throw new Error(
      targetRef
        ? `Target SHA ${revision} is not available locally after fetching ${targetRef}`
        : `Target SHA ${revision} is not available locally; pass --target-ref so it can be fetched by name`,
    );
  }
  return resolvedSha;
}

function targetVersionForTarget(
  targetSha: string,
  readPackageJson: (sha: string) => string = (sha) => run("git", ["show", `${sha}:package.json`]),
): string {
  let version: unknown;
  try {
    version = JSON.parse(readPackageJson(targetSha)).version;
  } catch {
    throw new Error(`Could not read package.json from target SHA ${targetSha}`);
  }
  if (typeof version !== "string" || !/^[0-9]{4}\.[0-9]+\.[0-9]+(?:-.+)?$/u.test(version)) {
    throw new Error(`Target SHA ${targetSha} has an invalid package version`);
  }
  return version;
}

function releaseProfileForVersion(version: string): "beta" | "stable" {
  return /-(?:alpha|beta)\.[1-9][0-9]*$/u.test(version) ? "beta" : "stable";
}

export function releaseProfileForTarget(
  targetSha: string,
  readPackageJson: (sha: string) => string = (sha) => run("git", ["show", `${sha}:package.json`]),
): "beta" | "stable" {
  return releaseProfileForVersion(targetVersionForTarget(targetSha, readPackageJson));
}

export function verifyTrustedWorkflowRef(
  workflowSha: string,
  trustedWorkflowRef: string,
  resolveRemoteTagSha: (tag: string) => string = (tag) =>
    run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).split(/\s+/u)[0] ?? "",
  isMainAncestor: (sha: string) => boolean = (sha) =>
    runStatus("git", ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"]).status === 0,
) {
  if (trustedWorkflowRef === "main") {
    if (!isMainAncestor(workflowSha)) {
      throw new Error(
        `Workflow SHA ${workflowSha} is not reachable from current origin/main; refusing an untrusted release harness.`,
      );
    }
    return;
  }

  const tagMatch = trustedWorkflowRef.match(TRUSTED_WORKFLOW_TAG_PATTERN);
  if (!tagMatch) {
    throw new Error(
      "trusted workflow ref must be main or a protected release-publish/<12hex>-<decimal> tag",
    );
  }
  if (workflowSha.slice(0, 12) !== tagMatch[1]) {
    throw new Error(
      `Trusted workflow tag ${trustedWorkflowRef} does not match Tooling SHA ${workflowSha}`,
    );
  }
  const remoteTagSha = resolveRemoteTagSha(trustedWorkflowRef);
  if (!remoteTagSha) {
    throw new Error(`Trusted workflow tag ${trustedWorkflowRef} does not exist on origin`);
  }
  if (remoteTagSha.toLowerCase() !== workflowSha.toLowerCase()) {
    throw new Error(
      `Trusted workflow tag ${trustedWorkflowRef} resolves to ${remoteTagSha}, expected ${workflowSha}`,
    );
  }
}

function resolveTrustedWorkflowSha(requestedSha: string, trustedWorkflowRef: string) {
  if (trustedWorkflowRef === "main") {
    run("git", ["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"], {
      stdio: "inherit",
    });
  }
  const workflowSha = resolveSha(requestedSha || "origin/main");
  verifyTrustedWorkflowRef(workflowSha, trustedWorkflowRef);
  return workflowSha;
}

function collectRunId(dispatchOutput: string) {
  const match = dispatchOutput.match(/actions\/runs\/(\d+)/);
  return match?.[1] ?? "";
}

function findLatestRunId(branch: string, sha: string) {
  const json = execGhRead(
    [
      "run",
      "list",
      "--workflow",
      WORKFLOW,
      "--branch",
      branch,
      "--event",
      "workflow_dispatch",
      "--limit",
      "20",
      "--json",
      "databaseId,headSha,createdAt",
    ],
    GH_READ_OPTIONS,
  );
  const runs: unknown = JSON.parse(json);
  if (!Array.isArray(runs)) {
    throw new Error("Full Release Validation run list response was not an array");
  }
  const match = runs.find((runItem: unknown) => isJsonRecord(runItem) && runItem.headSha === sha);
  const databaseId = isJsonRecord(match) ? match.databaseId : undefined;
  return typeof databaseId === "string" || typeof databaseId === "number" ? String(databaseId) : "";
}

function readWorkflowRun(parentRunId: string, workflowSha: string) {
  if (!/^[1-9][0-9]*$/u.test(parentRunId)) {
    throw new Error("parent run ID must be a positive decimal");
  }
  const workflowRun: unknown = JSON.parse(
    execGhRead(["api", `repos/openclaw/openclaw/actions/runs/${parentRunId}`], GH_READ_OPTIONS),
  );
  if (!isJsonRecord(workflowRun)) {
    throw new Error(`Full Release Validation run ${parentRunId} returned an invalid response`);
  }
  if (workflowRun.head_sha !== workflowSha) {
    throw new Error(
      `Full Release Validation run ${parentRunId} head ${displayValue(workflowRun.head_sha)} does not match trusted workflow SHA ${workflowSha}`,
    );
  }
  return workflowRun;
}

function readActiveParentJobs(parentRunId: string) {
  const response: unknown = JSON.parse(
    execGhRead(
      ["api", `repos/openclaw/openclaw/actions/runs/${parentRunId}/jobs?per_page=100`],
      GH_READ_OPTIONS,
    ),
  );
  if (!isJsonRecord(response) || !Array.isArray(response.jobs)) {
    throw new Error(`Full Release Validation run ${parentRunId} returned invalid jobs`);
  }
  return response.jobs
    .filter((job) => isJsonRecord(job) && job.status !== "completed")
    .map((job) => ({
      name: isJsonRecord(job) ? stringValue(job.name, "<unnamed>") : "<unnamed>",
      status: isJsonRecord(job) ? stringValue(job.status, "pending") : "pending",
      url: isJsonRecord(job) ? stringValue(job.html_url) : "",
    }));
}

export function validateReleaseDecisionPayload(
  payload: unknown,
  expected: {
    parentRunAttempt: number;
    parentRunId: string;
    workflowSha: string;
  },
) {
  return validateReleaseStateArtifact(
    payload,
    {
      parentRunAttempt: expected.parentRunAttempt,
      parentRunId: expected.parentRunId,
      workflowSha: expected.workflowSha,
    },
    "decision",
  );
}

export function releaseDecisionStopsForeground(state: unknown) {
  return [
    "blocked_diagnostics_running",
    "blocked_complete",
    "orchestration_error",
    "cancelled_with_children",
  ].includes(stringValue(state));
}

export function tryReadReleaseDecision(
  parentRunId: string,
  parentRunAttempt: number,
  workflowSha: string,
  runStatusImpl: (
    command: string,
    args: string[],
    options?: CommandOptions,
  ) => CommandStatus = runStatus,
) {
  const artifactName = `full-release-decision-${parentRunId}-${parentRunAttempt}`;
  const downloadDir = mkdtempSync(join(tmpdir(), "openclaw-release-decision-"));
  try {
    const result = runStatusImpl(
      "gh",
      [
        "run",
        "download",
        parentRunId,
        "--repo",
        "openclaw/openclaw",
        "--name",
        artifactName,
        "--dir",
        downloadDir,
      ],
      { stdio: ["ignore", "ignore", "pipe"], timeoutMs: GH_READ_TIMEOUT_MS },
    );
    if (result.status !== 0) {
      const stderr = stringValue(result.stderr);
      if (isReleaseGhArtifactMissingError({ cause: result.error, stderr })) {
        return undefined;
      }
      const downloadError = Object.assign(
        result.error instanceof Error
          ? result.error
          : new Error(
              `Release Decision artifact download failed${
                stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""
              }`,
            ),
        {
          signal: result.signal,
          status: result.status,
          stderr,
        },
      );
      if (classifyReleaseGhTransportError(downloadError) === "transient") {
        console.warn(
          `Release Decision artifact unavailable this poll; retrying: ${downloadError.message}`,
        );
        return undefined;
      }
      throw new Error(
        `Release Decision artifact download failed${
          stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""
        }`,
        { cause: downloadError },
      );
    }
    const decisionPath = join(downloadDir, RELEASE_DECISION_FILE);
    if (!existsSync(decisionPath)) {
      throw new Error(
        `Release Decision artifact ${artifactName} omitted ${RELEASE_DECISION_FILE}.`,
      );
    }
    if (statSync(decisionPath).size > MAX_RELEASE_DECISION_BYTES) {
      throw new Error(`Release Decision artifact ${artifactName} exceeds the size limit.`);
    }
    return validateReleaseDecisionPayload(JSON.parse(readFileSync(decisionPath, "utf8")), {
      parentRunAttempt,
      parentRunId,
      workflowSha,
    });
  } finally {
    rmSync(downloadDir, { force: true, recursive: true });
  }
}

function waitForWorkflowRun(parentRunId: string, workflowSha: string) {
  let lastSummary = "";
  let consecutiveErrors = 0;
  const startedAt = Date.now();
  const deadline = startedAt + FULL_RELEASE_WAIT_TIMEOUT_MINUTES * 60_000;
  let nextProgressAt = startedAt + FULL_RELEASE_GITHUB_POLL_INTERVAL_MS;
  while (Date.now() < deadline) {
    let suite: Record<string, unknown> | undefined;
    try {
      suite = readWorkflowRun(parentRunId, workflowSha);
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Parent run status query failed; retrying: ${message}`);
    }

    const status = stringValue(suite?.status, "pending").toLowerCase();
    const conclusion = stringValue(suite?.conclusion, "pending").toLowerCase();
    const summary = `${status}/${conclusion}`;
    if (summary !== lastSummary) {
      console.log(`Parent run status: ${summary}`);
      lastSummary = summary;
    }
    if (suite) {
      const releaseDecision = tryReadReleaseDecision(
        parentRunId,
        requiredPositiveInteger(suite.run_attempt, "parent run attempt"),
        workflowSha,
      );
      if (releaseDecision && releaseDecisionStopsForeground(releaseDecision.state)) {
        throw new Error(
          `${formatReleaseStateOutcome(releaseDecision)}\nhttps://github.com/openclaw/openclaw/actions/runs/${parentRunId}`,
        );
      }
    }
    if (suite?.status === "completed" && stringValue(suite.conclusion)) {
      if (suite.conclusion === "success") {
        return suite;
      }
      throw new Error(
        `Full Release Validation concluded ${stringValue(suite.conclusion, "unknown").toLowerCase()}: https://github.com/openclaw/openclaw/actions/runs/${parentRunId}`,
      );
    }
    const now = Date.now();
    if (now >= nextProgressAt) {
      const elapsedMinutes = Math.floor((now - startedAt) / 60_000);
      try {
        const activeJobs = readActiveParentJobs(parentRunId);
        console.log(
          `Parent run progress after ${elapsedMinutes}m: ${activeJobs.length} active job(s)`,
        );
        for (const job of activeJobs) {
          console.log(`- ${job.name}: ${job.status}${job.url ? ` ${job.url}` : ""}`);
        }
      } catch (error) {
        console.warn(
          `Parent run progress query failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      nextProgressAt += FULL_RELEASE_GITHUB_POLL_INTERVAL_MS;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      Math.min(FULL_RELEASE_GITHUB_POLL_INTERVAL_MS, remainingMs),
    );
  }
  throw new Error(
    `Timed out after ${FULL_RELEASE_WAIT_TIMEOUT_MINUTES} minutes waiting for Full Release Validation: https://github.com/openclaw/openclaw/actions/runs/${parentRunId}`,
  );
}

export function releaseEvidenceVerificationArgs(
  parentRunId: unknown,
  verifierSourceSha: string,
  verifierSourceFile: string,
  trustedWorkflowRef = "main",
) {
  if (!/^[1-9][0-9]*$/u.test(String(parentRunId))) {
    throw new Error("parent run ID must be a positive decimal");
  }
  const trustedWorkflowFullRef =
    trustedWorkflowRef === "main"
      ? "refs/heads/main"
      : TRUSTED_WORKFLOW_TAG_PATTERN.test(trustedWorkflowRef)
        ? `refs/tags/${trustedWorkflowRef}`
        : "";
  if (!trustedWorkflowFullRef) {
    throw new Error("trusted workflow ref must be main or a protected release-publish tag");
  }
  return [
    "--validate-run",
    String(parentRunId),
    "--trusted-workflow-ref",
    trustedWorkflowRef,
    "--trusted-workflow-full-ref",
    trustedWorkflowFullRef,
    "--trusted-workflow-sha",
    verifierSourceSha,
    "--json",
    "--verifier-source-sha",
    verifierSourceSha,
    "--verifier-source-file",
    verifierSourceFile,
  ];
}

export function shouldDeleteTemporaryWorkflowRef(params: TemporaryRefParams) {
  return (
    !params.keepBranch &&
    (params.dryRun || (params.parentConclusion === "success" && params.evidenceVerified))
  );
}

export function assertTrustedWorkflowHarness(
  workflowSha: string,
  pathExists: (relativePath: string) => boolean = (relativePath) =>
    runStatus("git", ["cat-file", "-e", `${workflowSha}:${relativePath}`], {
      stdio: ["ignore", "ignore", "ignore"],
    }).status === 0,
  readPath: (relativePath: string) => string = (relativePath) =>
    run("git", ["show", `${workflowSha}:${relativePath}`]),
): TrustedWorkflowHarness {
  if (!pathExists(TRUSTED_WORKFLOW_PATH)) {
    throw new Error(
      `trusted workflow SHA ${workflowSha} does not contain ${TRUSTED_WORKFLOW_PATH}`,
    );
  }
  let workflow: unknown;
  try {
    workflow = parseYaml(readPath(TRUSTED_WORKFLOW_PATH));
  } catch (error) {
    throw new Error(
      `Tooling SHA ${workflowSha} contains invalid ${TRUSTED_WORKFLOW_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const contract =
    isJsonRecord(workflow) && isJsonRecord(workflow.env)
      ? workflow.env[RELEASE_ISOLATION_TOOLING_CONTRACT_ENV]
      : undefined;
  if (contract !== "1" && contract !== RELEASE_ISOLATION_TOOLING_CONTRACT) {
    throw new Error(
      `Tooling SHA ${workflowSha} does not declare a supported ${RELEASE_ISOLATION_TOOLING_CONTRACT_ENV} in ${TRUSTED_WORKFLOW_PATH}`,
    );
  }
  const workflowInputs =
    isJsonRecord(workflow) &&
    isJsonRecord(workflow.on) &&
    isJsonRecord(workflow.on.workflow_dispatch) &&
    isJsonRecord(workflow.on.workflow_dispatch.inputs)
      ? workflow.on.workflow_dispatch.inputs
      : undefined;
  if (!workflowInputs || !Object.hasOwn(workflowInputs, "expected_sha")) {
    throw new Error(
      `Tooling SHA ${workflowSha} is missing workflow_dispatch input expected_sha in ${TRUSTED_WORKFLOW_PATH}`,
    );
  }
  if (
    contract === RELEASE_ISOLATION_TOOLING_CONTRACT &&
    !Object.hasOwn(workflowInputs, "trusted_workflow_json")
  ) {
    throw new Error(
      `Tooling SHA ${workflowSha} declares ${RELEASE_ISOLATION_TOOLING_CONTRACT_ENV}=2 but is missing workflow_dispatch input trusted_workflow_json in ${TRUSTED_WORKFLOW_PATH}`,
    );
  }
  const verifierPath = RELEASE_EVIDENCE_VERIFIER_PATHS.find((relativePath) =>
    pathExists(relativePath),
  );
  if (!verifierPath) {
    throw new Error(
      `trusted workflow SHA ${workflowSha} does not contain a supported release evidence verifier`,
    );
  }
  return { contract, verifierPath };
}

export function releaseEvidenceVerifierPath(worktreeRoot: string) {
  const candidates = RELEASE_EVIDENCE_VERIFIER_PATHS.map((relativePath) =>
    join(worktreeRoot, relativePath),
  );
  const verifier = candidates.find((candidate) => existsSync(candidate));
  if (!verifier) {
    throw new Error("trusted workflow checkout does not contain a release evidence verifier");
  }
  return verifier;
}

function verifyReleaseEvidence(
  parentRunId: string,
  workflowSha: string,
  trustedWorkflowRef: string,
) {
  const verifierWorktree = mkdtempSync(join(tmpdir(), "openclaw-release-verifier-"));
  try {
    run("git", ["worktree", "add", "--detach", verifierWorktree, workflowSha], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    const verifier = releaseEvidenceVerifierPath(verifierWorktree);
    const evidence: unknown = JSON.parse(
      run(process.execPath, [
        verifier,
        ...releaseEvidenceVerificationArgs(parentRunId, workflowSha, verifier, trustedWorkflowRef),
      ]),
    );
    if (
      !isJsonRecord(evidence) ||
      evidence.valid !== true ||
      !isJsonRecord(evidence.current) ||
      !isJsonRecord(evidence.root)
    ) {
      throw new Error(`Full Release Validation evidence is invalid for run ${parentRunId}.`);
    }
    console.log(
      `ok release evidence current=${displayValue(evidence.current.runId)} root=${displayValue(evidence.root.runId)} reused=${Boolean(evidence.evidenceReuse)}`,
    );
  } finally {
    runStatus("git", ["worktree", "remove", "--force", verifierWorktree], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    rmSync(verifierWorktree, { force: true, recursive: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetSha = resolveTargetSha(args.sha, args.targetRef);
  const targetVersion = targetVersionForTarget(targetSha);
  args.inputs.release_profile ??= releaseProfileForVersion(targetVersion);
  args.inputs.allow_unreleased_changelog ??= args.targetRef ? "false" : "true";
  const targetContextRef = verifyTargetRef(args.targetRef, targetSha, targetVersion);
  const workflowSha = resolveTrustedWorkflowSha(args.workflowSha, args.trustedWorkflowRef);
  const trustedWorkflowHarness = assertTrustedWorkflowHarness(workflowSha);
  if (trustedWorkflowHarness.contract === "1") {
    args.inputs.reuse_evidence = "false";
  }
  const shortSha = workflowSha.slice(0, 12);
  const branch = `release-ci/${shortSha}-${Date.now()}`;
  const remoteBranchRef = `refs/heads/${branch}`;
  const targetBranch = `validation/target-${targetSha.slice(0, 12)}-${Date.now()}`;
  const remoteTargetBranchRef = `refs/heads/${targetBranch}`;
  const dispatchInputs = {
    ref: targetSha,
    expected_sha: targetSha,
    ...(trustedWorkflowHarness.contract === RELEASE_ISOLATION_TOOLING_CONTRACT
      ? {
          trusted_workflow_json: JSON.stringify({
            ref: args.trustedWorkflowRef,
            fullRef:
              args.trustedWorkflowRef === "main"
                ? "refs/heads/main"
                : `refs/tags/${args.trustedWorkflowRef}`,
            sha: workflowSha,
          }),
        }
      : {}),
    ...(targetContextRef !== targetSha ? { target_context_ref: targetContextRef } : {}),
    ...args.inputs,
  };

  console.log(`Validation SHA: ${targetSha}`);
  console.log(`Tooling SHA: ${workflowSha}`);
  console.log(`Trusted workflow ref: ${args.trustedWorkflowRef}`);
  console.log(
    `Frozen validation tuple: candidate=${targetSha} tooling=${workflowSha} rerun_group=${args.inputs.rerun_group}`,
  );
  console.log(`Temporary target ref: ${targetBranch}`);
  console.log(`Temporary workflow ref: ${branch}`);

  let parentRunId: string | undefined;
  let parentConclusion = "";
  let evidenceVerified = false;
  try {
    run("git", ["push", "origin", `${targetSha}:${remoteTargetBranchRef}`], {
      dryRun: args.dryRun,
      stdio: "inherit",
    });
    run("git", ["push", "origin", `${workflowSha}:${remoteBranchRef}`], {
      dryRun: args.dryRun,
      stdio: "inherit",
    });

    const dispatchArgs = ["workflow", "run", WORKFLOW, "--ref", branch];
    for (const [key, value] of Object.entries(dispatchInputs)) {
      dispatchArgs.push("-f", `${key}=${value}`);
    }

    const dispatchOutput = run("gh", dispatchArgs, { dryRun: args.dryRun });
    if (dispatchOutput) {
      console.log(dispatchOutput);
    }
    parentRunId = collectRunId(dispatchOutput);
    if (!parentRunId && !args.dryRun) {
      for (let attempt = 0; attempt < FULL_RELEASE_RUN_DISCOVERY_ATTEMPTS; attempt += 1) {
        parentRunId = findLatestRunId(branch, workflowSha);
        if (parentRunId) {
          break;
        }
        if (attempt + 1 < FULL_RELEASE_RUN_DISCOVERY_ATTEMPTS) {
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            FULL_RELEASE_GITHUB_POLL_INTERVAL_MS,
          );
        }
      }
    }
    if (!parentRunId) {
      if (args.dryRun) {
        return;
      }
      throw new Error("Could not determine Full Release Validation run id.");
    }

    console.log(`Parent run: https://github.com/openclaw/openclaw/actions/runs/${parentRunId}`);
    const completedRun = waitForWorkflowRun(parentRunId, workflowSha);
    parentConclusion = stringValue(completedRun.conclusion);
    if (parentConclusion !== "success") {
      throw new Error(
        `Full Release Validation concluded ${parentConclusion.toLowerCase() || "without a conclusion"}: https://github.com/openclaw/openclaw/actions/runs/${parentRunId}`,
      );
    }
    verifyReleaseEvidence(parentRunId, workflowSha, args.trustedWorkflowRef);
    evidenceVerified = true;
  } finally {
    if (
      shouldDeleteTemporaryWorkflowRef({
        keepBranch: args.keepBranch,
        dryRun: args.dryRun,
        parentConclusion,
        evidenceVerified,
      })
    ) {
      run("git", ["push", "origin", `:${remoteBranchRef}`, `:${remoteTargetBranchRef}`], {
        dryRun: args.dryRun,
        stdio: "inherit",
      });
    } else {
      const keptRefs = `${remoteBranchRef} and ${remoteTargetBranchRef}`;
      console.warn(
        args.keepBranch
          ? `Kept ${keptRefs}`
          : `Kept ${keptRefs}: ${
              parentConclusion === "success"
                ? "release evidence was not verified"
                : `parent concluded ${parentConclusion || "without a conclusion"}`
            }. Keep it through GitHub reruns or evidence diagnosis; delete it after verified success.`,
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(
      `[full-release-validation] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("[full-release-validation] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
