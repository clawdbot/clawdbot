#!/usr/bin/env node
// Dispatches full release validation against a temporary SHA-pinned branch.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const WORKFLOW = "full-release-validation.yml";
const RELEASE_BRANCH_PATTERN =
  /^(?:release\/[0-9]{4}\.[0-9]+\.[0-9]+|extended-stable\/[0-9]{4}\.[0-9]+\.33)$/u;
const RELEASE_TAG_PATTERN = /^v[0-9]{4}\.[0-9]+\.[0-9]+(?:-(?:alpha|beta)\.[0-9]+)?$/u;
const DEFAULT_INPUTS = {
  provider: "openai",
  mode: "both",
  rerun_group: "all",
  reuse_evidence: "true",
};
const MAX_CONSECUTIVE_STATUS_ERRORS = 12;

function usage() {
  console.error(`Usage: node scripts/full-release-validation-at-sha.mjs [--sha <target-sha>] [--target-ref <canonical-release-branch-or-tag>] [--workflow-sha <trusted-main-ref>] [--keep-branch] [--dry-run] [-- -f key=value ...]

Creates a temporary remote branch pinned to trusted main release tooling,
dispatches Full Release Validation with the target commit as its ref input,
watches the parent run, verifies all child workflow head SHAs match the trusted
workflow lineage through the release evidence manifest, then deletes the
temporary branch by default. Exact-target and changelog-only Release SHA
evidence reuse stay enabled; pass -f reuse_evidence=false to force a fresh
run. The release profile defaults to beta for alpha/beta package versions and
stable otherwise; pass -f release_profile=full for the broad advisory sweep.`);
}

function run(command, args, options = {}) {
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

function runStatus(command, args, options = {}) {
  if (options.dryRun) {
    console.log(["+", command, ...args].join(" "));
    return { status: 0, stdout: "" };
  }
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "inherit"],
  });
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const args = {
    sha: "",
    targetRef: "",
    workflowSha: "",
    keepBranch: false,
    dryRun: false,
    inputs: { ...DEFAULT_INPUTS },
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
        const extra = extras[extraIndex];
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
  if (
    Object.hasOwn(args.inputs, "allow_unreleased_changelog") &&
    !["true", "false"].includes(args.inputs.allow_unreleased_changelog)
  ) {
    throw new Error("allow_unreleased_changelog must be true or false");
  }
  if (
    args.inputs.release_profile &&
    !["beta", "stable", "full"].includes(args.inputs.release_profile)
  ) {
    throw new Error("release_profile must be beta, stable, or full");
  }
  if (Object.hasOwn(args.inputs, "ref")) {
    throw new Error("SHA-pinned release validation reserves the ref input for --sha");
  }
  if (
    args.targetRef &&
    !RELEASE_BRANCH_PATTERN.test(args.targetRef) &&
    !RELEASE_TAG_PATTERN.test(args.targetRef)
  ) {
    throw new Error("--target-ref must be a canonical OpenClaw release branch or tag");
  }
  return args;
}

export function resolveRemoteTargetRefSha(targetRef, executeGit = (args) => run("git", args)) {
  if (RELEASE_BRANCH_PATTERN.test(targetRef)) {
    return executeGit(["ls-remote", "--heads", "origin", `refs/heads/${targetRef}`]).split(
      /\s+/u,
    )[0];
  }

  const tagRef = `refs/tags/${targetRef}`;
  const peeledSha = executeGit(["ls-remote", "--tags", "origin", `${tagRef}^{}`]).split(/\s+/u)[0];
  if (peeledSha) {
    return peeledSha;
  }
  return executeGit(["ls-remote", "--tags", "origin", tagRef]).split(/\s+/u)[0];
}

function verifyTargetRef(targetRef, targetSha) {
  if (!targetRef) {
    return targetSha;
  }
  const remoteSha = resolveRemoteTargetRefSha(targetRef);
  if (remoteSha !== targetSha) {
    throw new Error(`Target ref ${targetRef} does not resolve to ${targetSha}`);
  }
  return targetRef;
}

function resolveSha(requestedSha) {
  const rev = requestedSha || "HEAD";
  return run("git", ["rev-parse", "--verify", `${rev}^{commit}`], { dryRun: false });
}

export function releaseProfileForTarget(
  targetSha,
  readPackageJson = (sha) => run("git", ["show", `${sha}:package.json`]),
) {
  let version;
  try {
    version = JSON.parse(readPackageJson(targetSha)).version;
  } catch {
    throw new Error(`Could not read package.json from target SHA ${targetSha}`);
  }
  if (typeof version !== "string" || !/^[0-9]{4}\.[0-9]+\.[0-9]+(?:-.+)?$/u.test(version)) {
    throw new Error(`Target SHA ${targetSha} has an invalid package version`);
  }
  return /-(?:alpha|beta)\.[1-9][0-9]*$/u.test(version) ? "beta" : "stable";
}

function resolveTrustedWorkflowSha(requestedSha) {
  run("git", ["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"], {
    stdio: "inherit",
  });
  const workflowSha = resolveSha(requestedSha || "origin/main");
  const ancestry = runStatus("git", [
    "merge-base",
    "--is-ancestor",
    workflowSha,
    "refs/remotes/origin/main",
  ]);
  if (ancestry.status !== 0) {
    throw new Error(
      `Workflow SHA ${workflowSha} is not reachable from current origin/main; refusing an untrusted release harness.`,
    );
  }
  return workflowSha;
}

function collectRunId(dispatchOutput) {
  const match = dispatchOutput.match(/actions\/runs\/(\d+)/);
  return match?.[1] ?? "";
}

function findLatestRunId(branch, sha) {
  const json = run("gh", [
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
  ]);
  const runs = JSON.parse(json);
  const match = runs.find((runItem) => runItem.headSha === sha);
  return match?.databaseId ? String(match.databaseId) : "";
}

function readWorkflowRun(parentRunId, workflowSha) {
  if (!/^[1-9][0-9]*$/u.test(String(parentRunId))) {
    throw new Error("parent run ID must be a positive decimal");
  }
  const workflowRun = JSON.parse(
    run("gh", ["api", `repos/openclaw/openclaw/actions/runs/${parentRunId}`]),
  );
  if (workflowRun.head_sha !== workflowSha) {
    throw new Error(
      `Full Release Validation run ${parentRunId} head ${String(workflowRun.head_sha)} does not match trusted workflow SHA ${workflowSha}`,
    );
  }
  return workflowRun;
}

function waitForWorkflowRun(parentRunId, workflowSha) {
  let lastSummary = "";
  let consecutiveErrors = 0;
  for (let attempt = 0; attempt < 480; attempt += 1) {
    let suite;
    try {
      suite = readWorkflowRun(parentRunId, workflowSha);
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_STATUS_ERRORS) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Parent run status query failed; retrying: ${message}`);
    }

    const summary = `${String(suite?.status ?? "pending").toLowerCase()}/${String(suite?.conclusion ?? "pending").toLowerCase()}`;
    if (summary !== lastSummary) {
      console.log(`Parent run status: ${summary}`);
      lastSummary = summary;
    }
    if (suite?.status === "completed") {
      return suite;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 45_000);
  }
  throw new Error(
    `Timed out waiting for Full Release Validation: https://github.com/openclaw/openclaw/actions/runs/${parentRunId}`,
  );
}

export function shouldDeleteTemporaryWorkflowRef(params) {
  return !params.keepBranch && (params.dryRun || params.parentRunCompleted);
}

export function releaseEvidenceVerificationArgs(parentRunId) {
  if (!/^[1-9][0-9]*$/u.test(String(parentRunId))) {
    throw new Error("parent run ID must be a positive decimal");
  }
  return ["--validate-run", String(parentRunId), "--trusted-workflow-ref", "main", "--json"];
}

export function releaseEvidenceVerifierPath(worktreeRoot) {
  const candidates = [
    join(worktreeRoot, "scripts", "release-ci-summary.mjs"),
    join(
      worktreeRoot,
      ".agents",
      "skills",
      "release-openclaw-ci",
      "scripts",
      "release-ci-summary.mjs",
    ),
  ];
  const verifier = candidates.find((candidate) => existsSync(candidate));
  if (!verifier) {
    throw new Error("trusted workflow checkout does not contain a release evidence verifier");
  }
  return verifier;
}

function verifyReleaseEvidence(parentRunId, workflowSha) {
  const verifierWorktree = mkdtempSync(join(tmpdir(), "openclaw-release-verifier-"));
  try {
    run("git", ["worktree", "add", "--detach", verifierWorktree, workflowSha], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    const verifier = releaseEvidenceVerifierPath(verifierWorktree);
    const evidence = JSON.parse(
      run(process.execPath, [verifier, ...releaseEvidenceVerificationArgs(parentRunId)]),
    );
    if (evidence.valid !== true) {
      throw new Error(`Full Release Validation evidence is invalid for run ${parentRunId}.`);
    }
    console.log(
      `ok release evidence current=${evidence.current.runId} root=${evidence.root.runId} reused=${Boolean(evidence.evidenceReuse)}`,
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
  const targetSha = resolveSha(args.sha);
  args.inputs.release_profile ??= releaseProfileForTarget(targetSha);
  args.inputs.allow_unreleased_changelog ??= args.targetRef ? "false" : "true";
  const targetContextRef = verifyTargetRef(args.targetRef, targetSha);
  const workflowSha = resolveTrustedWorkflowSha(args.workflowSha);
  const shortSha = workflowSha.slice(0, 12);
  const branch = `release-ci/${shortSha}-${Date.now()}`;
  const remoteBranchRef = `refs/heads/${branch}`;
  const dispatchInputs = {
    ref: targetSha,
    ...(targetContextRef !== targetSha ? { target_context_ref: targetContextRef } : {}),
    ...args.inputs,
  };

  console.log(`Target SHA: ${targetSha}`);
  console.log(`Trusted workflow SHA: ${workflowSha}`);
  console.log(`Temporary workflow ref: ${branch}`);

  run("git", ["push", "origin", `${workflowSha}:${remoteBranchRef}`], {
    dryRun: args.dryRun,
    stdio: "inherit",
  });

  let parentRunId;
  let parentRunCompleted = false;
  try {
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
      for (let attempt = 0; attempt < 60; attempt += 1) {
        parentRunId = findLatestRunId(branch, workflowSha);
        if (parentRunId) {
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
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
    parentRunCompleted = true;
    if (completedRun.conclusion !== "success") {
      throw new Error(
        `Full Release Validation concluded ${String(completedRun.conclusion).toLowerCase()}: https://github.com/openclaw/openclaw/actions/runs/${parentRunId}`,
      );
    }
    verifyReleaseEvidence(parentRunId, workflowSha);
  } finally {
    if (
      shouldDeleteTemporaryWorkflowRef({
        keepBranch: args.keepBranch,
        dryRun: args.dryRun,
        parentRunCompleted,
      })
    ) {
      run("git", ["push", "origin", `:${remoteBranchRef}`], {
        dryRun: args.dryRun,
        stdio: "inherit",
      });
    } else if (args.keepBranch) {
      console.log(`Kept ${remoteBranchRef}`);
    } else {
      console.warn(
        `Kept ${remoteBranchRef}: parent completion was not confirmed. Delete it only after the run finishes.`,
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
