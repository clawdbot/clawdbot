#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const RELEASE_PUBLISH_REF_PATTERN = /^release-publish\/([a-f0-9]{12})-([1-9][0-9]*)$/u;
const WORKFLOW_PATH = ".github/workflows/openclaw-npm-release.yml";

function fail(message) {
  throw new Error(message);
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON.`, { cause: error });
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`OpenClaw npm resume run is missing ${label}.`);
  }
  return value;
}

function requiredSha(value, label) {
  const sha = requiredString(value, label);
  if (!SHA_PATTERN.test(sha)) {
    fail(`OpenClaw npm resume run has invalid ${label}.`);
  }
  return sha;
}

function trustedWorkflowPath(path, branch) {
  return new Set([
    WORKFLOW_PATH,
    `${WORKFLOW_PATH}@${branch}`,
    `${WORKFLOW_PATH}@refs/tags/${branch}`,
  ]).has(path);
}

export function validateOpenClawNpmResumeRun({
  canonicalWorkflowId,
  compareStatus,
  jobs,
  run,
  tag,
  tagRef,
}) {
  const url = requiredString(run?.html_url, "html_url");
  const branch = requiredString(run?.head_branch, "head_branch");
  const branchMatch = RELEASE_PUBLISH_REF_PATTERN.exec(branch);
  if (!branchMatch) {
    fail(`OpenClaw npm resume run has an untrusted workflow ref: ${url}`);
  }

  const sha = requiredSha(run?.head_sha, "head_sha");
  const path = requiredString(run?.path, "path");
  if (
    run?.conclusion !== "success" ||
    run?.event !== "workflow_dispatch" ||
    !trustedWorkflowPath(path, branch) ||
    run?.workflow_id !== canonicalWorkflowId ||
    sha.slice(0, 12) !== branchMatch[1]
  ) {
    fail(`OpenClaw npm resume run has an untrusted workflow identity: ${url}`);
  }

  const tagObjectSha = requiredSha(tagRef?.object?.sha, "tooling tag object SHA");
  if (tagRef?.object?.type !== "tag") {
    fail(`OpenClaw npm resume run tooling ref is not a signed annotated tag: ${url}`);
  }

  const tagCommitSha = requiredSha(tag?.object?.sha, "tooling tag commit SHA");
  if (
    tag?.object?.type !== "commit" ||
    tagCommitSha !== sha ||
    tag?.verification?.verified !== true ||
    (compareStatus !== "ahead" && compareStatus !== "identical")
  ) {
    fail(
      `OpenClaw npm resume run is not bound to a real, main-reachable protected tooling tag: ${url}`,
    );
  }

  if (
    !Array.isArray(jobs) ||
    !jobs.some((job) => job?.name === "validate_publish_request" && job?.conclusion === "success")
  ) {
    fail(`OpenClaw npm resume run lacks successful parent release approval validation: ${url}`);
  }

  return {
    url,
    workflowRef: `refs/tags/${branch}`,
    workflowSha: sha,
    tagObjectSha,
  };
}

function defaultRunGh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

export function resolveOpenClawNpmResumeRun({ repo, runId, runGh = defaultRunGh }) {
  if (!/^[1-9][0-9]*$/u.test(runId)) {
    fail("OpenClaw npm resume run id must be a positive integer.");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
    fail("OpenClaw npm resume repository must be owner/name.");
  }

  const api = (endpoint) =>
    parseJson(runGh(["api", `repos/${repo}/${endpoint}`, "--method", "GET"]), endpoint);
  const run = api(`actions/runs/${runId}`);
  const canonicalWorkflow = api(`actions/workflows/${WORKFLOW_PATH.split("/").at(-1)}`);
  const branch = requiredString(run?.head_branch, "head_branch");
  const tagRef = api(`git/ref/tags/${branch}`);
  const tagObjectSha = requiredSha(tagRef?.object?.sha, "tooling tag object SHA");
  const tag = api(`git/tags/${tagObjectSha}`);
  const sha = requiredSha(run?.head_sha, "head_sha");
  const comparison = api(`compare/${sha}...main`);
  const jobs = parseJson(
    runGh(["run", "view", runId, "--repo", repo, "--json", "jobs", "--jq", ".jobs"]),
    "resume run jobs",
  );

  return validateOpenClawNpmResumeRun({
    canonicalWorkflowId: canonicalWorkflow?.id,
    compareStatus: comparison?.status,
    jobs,
    run,
    tag,
    tagRef,
  });
}

function parseArgs(argv) {
  const options = { repo: "", runId: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") {
      options.repo = argv[(index += 1)] ?? "";
    } else if (arg === "--run-id") {
      options.runId = argv[(index += 1)] ?? "";
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const result = resolveOpenClawNpmResumeRun(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
