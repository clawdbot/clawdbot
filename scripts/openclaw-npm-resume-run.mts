#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

type ResumeRunRecord = Partial<
  Record<
    "conclusion" | "event" | "head_branch" | "head_sha" | "html_url" | "path" | "workflow_id",
    unknown
  >
>;
type ResumeTagRecord = {
  object?: Partial<Record<"sha" | "type", unknown>>;
  verification?: { verified?: unknown };
};
type ResumeJobRecord = Partial<Record<"conclusion" | "name", unknown>>;

export interface OpenClawNpmResumeValidationInput {
  canonicalWorkflowId: unknown;
  compareStatus: unknown;
  jobs: ResumeJobRecord[];
  run: ResumeRunRecord;
  tag: ResumeTagRecord;
  tagRef: ResumeTagRecord;
}

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const RELEASE_PUBLISH_REF_PATTERN = /^release-publish\/([a-f0-9]{12})-([1-9][0-9]*)$/u;
const WORKFLOW_PATH = ".github/workflows/openclaw-npm-release.yml";
// Resume checks run during release recovery, so keep enough headroom for GitHub
// latency while preventing one stalled read from consuming the workflow budget.
const GH_COMMAND_TIMEOUT_MS = 60_000;

function fail(message: string): never {
  throw new Error(message);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON.`, { cause: error });
  }
}

function resumeRunRecord(value: unknown): ResumeRunRecord {
  return isRecord(value) ? value : {};
}

function resumeTagRecord(value: unknown): ResumeTagRecord {
  if (!isRecord(value)) {
    return {};
  }
  const object = isRecord(value.object)
    ? { sha: value.object.sha, type: value.object.type }
    : undefined;
  const verification = isRecord(value.verification)
    ? { verified: value.verification.verified }
    : undefined;
  return { object, verification };
}

function resumeJobRecords(value: unknown): ResumeJobRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`OpenClaw npm resume run is missing ${label}.`);
  }
  return value;
}

function requiredSha(value: unknown, label: string): string {
  const sha = requiredString(value, label);
  if (!SHA_PATTERN.test(sha)) {
    fail(`OpenClaw npm resume run has invalid ${label}.`);
  }
  return sha;
}

function trustedWorkflowPath(path: string, branch: string): boolean {
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
}: OpenClawNpmResumeValidationInput) {
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

export function runOpenClawNpmResumeGh(
  args: string[],
  params: {
    execFileSyncImpl?: typeof runGhCommand;
  } = {},
): string {
  const execFileSyncImpl = params.execFileSyncImpl ?? runGhCommand;
  return execFileSyncImpl("gh", args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024,
    timeout: GH_COMMAND_TIMEOUT_MS,
  });
}

function runGhCommand(
  command: string,
  args: string[],
  options: {
    encoding: "utf8";
    killSignal: "SIGKILL";
    maxBuffer: number;
    timeout: number;
  },
) {
  return execFileSync(command, args, options);
}

export function resolveOpenClawNpmResumeRun({
  repo,
  runId,
  runGh = runOpenClawNpmResumeGh,
}: {
  repo: string;
  runId: string;
  runGh?: (args: string[]) => string;
}) {
  if (!/^[1-9][0-9]*$/u.test(runId)) {
    fail("OpenClaw npm resume run id must be a positive integer.");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
    fail("OpenClaw npm resume repository must be owner/name.");
  }

  const api = (endpoint: string): unknown =>
    parseJson(runGh(["api", `repos/${repo}/${endpoint}`, "--method", "GET"]), endpoint);
  const run = resumeRunRecord(api(`actions/runs/${runId}`));
  const canonicalWorkflow = api(`actions/workflows/${WORKFLOW_PATH.split("/").at(-1)}`);
  const branch = requiredString(run?.head_branch, "head_branch");
  const tagRef = resumeTagRecord(api(`git/ref/tags/${branch}`));
  const tagObjectSha = requiredSha(tagRef?.object?.sha, "tooling tag object SHA");
  const tag = resumeTagRecord(api(`git/tags/${tagObjectSha}`));
  const sha = requiredSha(run?.head_sha, "head_sha");
  const comparison = api(`compare/${sha}...main`);
  const jobs = resumeJobRecords(
    parseJson(
      runGh(["run", "view", runId, "--repo", repo, "--json", "jobs", "--jq", ".jobs"]),
      "resume run jobs",
    ),
  );

  return validateOpenClawNpmResumeRun({
    canonicalWorkflowId: isRecord(canonicalWorkflow) ? canonicalWorkflow.id : undefined,
    compareStatus: isRecord(comparison) ? comparison.status : undefined,
    jobs,
    run,
    tag,
    tagRef,
  });
}

function parseArgs(argv: string[]): { repo: string; runId: string } {
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

function main(argv: string[] = process.argv.slice(2)): void {
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
