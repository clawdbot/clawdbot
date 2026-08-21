#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./lib/record-shared.mjs";
import {
  canonicalCandidateReceiptLockJson,
  CANDIDATE_RECEIPT_WORKFLOW_PATH,
  parseCandidateReceiptLockJson,
  validateCandidateReceiptLock,
  type CandidateReceiptLock,
} from "./release-candidate-receipt-contract.mjs";

type JsonRecord = Record<string, unknown>;
type RunGh = (args: string[]) => string;
type NormalizedCandidateReceiptLocatorOptions = CandidateReceiptLocatorOptions & {
  releasePlanDigest: string;
  timeoutMs: number;
  workflowId: string;
  workflowSha: string;
};

export type CandidateReceiptLocatorOptions = {
  dispatchId: string;
  releasePlanDigest: string;
  repo: string;
  runAttempt?: string;
  runGh?: RunGh;
  runId?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  workflowId: string;
  workflowSha: string;
};

const REPOSITORY = "openclaw/openclaw";
const RUN_NAME_PREFIX = "Release Candidate Artifacts";
const RECEIPT_FILE_NAME = "candidate-receipt-lock.json";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;
const DISPATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const GH_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 15_000;
const API_RETRY_ATTEMPTS = 3;
const API_RETRY_DELAY_MS = 1_000;

function fail(message: string): never {
  throw new Error(message);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} is missing`);
  }
  return value;
}

function positiveDecimal(value: unknown, label: string): string {
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof normalized !== "string" || !POSITIVE_DECIMAL_PATTERN.test(normalized)) {
    fail(`${label} must be a positive decimal integer`);
  }
  return normalized;
}

function sha(value: unknown, label: string): string {
  const normalized = requiredString(value, label);
  if (!SHA_PATTERN.test(normalized)) {
    fail(`${label} must be a lowercase full commit SHA`);
  }
  return normalized;
}

function digest(value: unknown, label: string): string {
  const normalized = requiredString(value, label);
  if (!DIGEST_PATTERN.test(normalized)) {
    fail(`${label} must be a prefixed lowercase SHA-256 digest`);
  }
  return normalized;
}

function requireOptions(
  options: CandidateReceiptLocatorOptions,
): NormalizedCandidateReceiptLocatorOptions {
  if (options.repo !== REPOSITORY) {
    fail(`candidate receipt repository must be ${REPOSITORY}`);
  }
  if (!DISPATCH_ID_PATTERN.test(options.dispatchId)) {
    fail("candidate receipt dispatch id is invalid");
  }
  const runPairCount =
    Number(options.runId !== undefined) + Number(options.runAttempt !== undefined);
  if (runPairCount === 1) {
    fail("candidate receipt exact run id and attempt must be supplied together");
  }
  return {
    ...options,
    releasePlanDigest: digest(options.releasePlanDigest, "release plan digest"),
    runAttempt:
      options.runAttempt === undefined
        ? undefined
        : positiveDecimal(options.runAttempt, "candidate receipt run attempt"),
    runId:
      options.runId === undefined
        ? undefined
        : positiveDecimal(options.runId, "candidate receipt run id"),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    workflowId: positiveDecimal(options.workflowId, "candidate receipt workflow id"),
    workflowSha: sha(options.workflowSha, "candidate receipt workflow SHA"),
  };
}

function artifactRecords(value: unknown): JsonRecord[] {
  const root = record(value, "candidate receipt artifact response");
  if (!Array.isArray(root.artifacts)) {
    fail("candidate receipt artifact response must contain artifacts");
  }
  return root.artifacts.map((entry, index) =>
    record(entry, `candidate receipt artifact response artifacts[${index}]`),
  );
}

function validateArtifactMetadata(
  artifact: JsonRecord,
  expected: {
    digest: string;
    id: string;
    name: string;
    runId: string;
  },
): void {
  const workflowRun = record(artifact.workflow_run, `${expected.name} workflow_run`);
  if (
    positiveDecimal(artifact.id, `${expected.name} artifact id`) !== expected.id ||
    requiredString(artifact.name, `${expected.name} artifact name`) !== expected.name ||
    digest(artifact.digest, `${expected.name} artifact digest`) !== expected.digest ||
    artifact.expired !== false ||
    positiveDecimal(workflowRun.id, `${expected.name} workflow run id`) !== expected.runId
  ) {
    fail(`${expected.name} metadata does not match the candidate receipt`);
  }
}

export function validateCandidateReceiptProvenance(params: {
  artifacts: unknown;
  expectedDispatchId: string;
  expectedReleasePlanDigest: string;
  expectedRunAttempt: string;
  expectedRunId: string;
  expectedWorkflowId: string;
  expectedWorkflowSha: string;
  lock: CandidateReceiptLock;
  run: unknown;
  workflow: unknown;
}): CandidateReceiptLock {
  const lock = validateCandidateReceiptLock(params.lock);
  const run = record(params.run, "candidate receipt run");
  const workflow = record(params.workflow, "candidate receipt workflow");
  const expectedTitle = `${RUN_NAME_PREFIX} ${params.expectedDispatchId}`;
  if (
    positiveDecimal(run.id, "candidate receipt run id") !== params.expectedRunId ||
    positiveDecimal(run.run_attempt, "candidate receipt run attempt") !==
      params.expectedRunAttempt ||
    positiveDecimal(run.workflow_id, "candidate receipt run workflow id") !==
      params.expectedWorkflowId ||
    sha(run.head_sha, "candidate receipt run head SHA") !== params.expectedWorkflowSha ||
    requiredString(run.path, "candidate receipt run path") !== CANDIDATE_RECEIPT_WORKFLOW_PATH ||
    requiredString(run.display_title, "candidate receipt run title") !== expectedTitle ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    fail("candidate receipt run does not match the exact successful producer attempt");
  }
  if (
    positiveDecimal(workflow.id, "candidate receipt workflow id") !== params.expectedWorkflowId ||
    requiredString(workflow.path, "candidate receipt workflow path") !==
      CANDIDATE_RECEIPT_WORKFLOW_PATH
  ) {
    fail("candidate receipt workflow identity does not match the canonical workflow");
  }

  const receipt = lock.receipt;
  if (
    receipt.release_plan_digest !== params.expectedReleasePlanDigest ||
    receipt.producer.repository !== REPOSITORY ||
    receipt.producer.workflow_path !== CANDIDATE_RECEIPT_WORKFLOW_PATH ||
    receipt.producer.workflow_id !== params.expectedWorkflowId ||
    receipt.producer.workflow_sha !== params.expectedWorkflowSha ||
    receipt.producer.run_id !== params.expectedRunId ||
    receipt.producer.run_attempt !== params.expectedRunAttempt
  ) {
    fail("candidate receipt payload does not match the requested producer provenance");
  }

  const artifacts = artifactRecords(params.artifacts);
  for (const artifact of Object.values(receipt.artifacts)) {
    const metadata = artifacts.find(
      (entry) =>
        positiveDecimal(entry.id, "candidate receipt artifact id") === artifact.artifact_id,
    );
    if (!metadata) {
      fail(`candidate receipt artifact ${artifact.artifact_id} is missing from the producer run`);
    }
    validateArtifactMetadata(metadata, {
      digest: artifact.artifact_digest,
      id: artifact.artifact_id,
      name: artifact.artifact_name,
      runId: params.expectedRunId,
    });
  }
  return lock;
}

export function runCandidateReceiptGh(
  args: string[],
  params: { execFileSyncImpl?: typeof runGhCommand } = {},
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
): string {
  return execFileSync(command, args, options);
}

async function pollUntil<T>(
  deadline: number,
  poll: () => Promise<T | undefined> | T | undefined,
  sleep: (milliseconds: number) => Promise<void>,
  timeoutMessage: string,
): Promise<T> {
  while (Date.now() <= deadline) {
    const result = await poll();
    if (result !== undefined) {
      return result;
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  return fail(timeoutMessage);
}

async function retryOperation<T>(
  deadline: number,
  sleep: (milliseconds: number) => Promise<void>,
  label: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  let lastError: unknown;
  let attempts = 0;
  for (let attempt = 1; attempt <= API_RETRY_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;
    }
    if (attempt === API_RETRY_ATTEMPTS || Date.now() >= deadline) {
      break;
    }
    await sleep(Math.min(API_RETRY_DELAY_MS * attempt, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`${label} failed after ${attempts} attempts`, { cause: lastError });
}

function discoverRun(
  responseValue: unknown,
  params: {
    dispatchId: string;
    workflowId: string;
    workflowSha: string;
  },
): { runAttempt: string; runId: string } | undefined {
  const response = record(responseValue, "candidate receipt workflow runs response");
  if (!Array.isArray(response.workflow_runs)) {
    fail("candidate receipt workflow runs response must contain workflow_runs");
  }
  const expectedTitle = `${RUN_NAME_PREFIX} ${params.dispatchId}`;
  const matches = response.workflow_runs
    .map((entry, index) => record(entry, `candidate receipt workflow_runs[${index}]`))
    .filter(
      (run) =>
        run.display_title === expectedTitle &&
        run.head_sha === params.workflowSha &&
        run.workflow_id !== undefined &&
        positiveDecimal(run.workflow_id, "candidate receipt discovered workflow id") ===
          params.workflowId,
    );
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length !== 1) {
    fail("candidate receipt dispatch id matched multiple workflow runs");
  }
  return {
    runAttempt: positiveDecimal(matches[0]!.run_attempt, "candidate receipt run attempt"),
    runId: positiveDecimal(matches[0]!.id, "candidate receipt run id"),
  };
}

export async function locateCandidateReceipt(
  rawOptions: CandidateReceiptLocatorOptions,
): Promise<CandidateReceiptLock> {
  const options = requireOptions(rawOptions);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    fail("candidate receipt timeout must be a positive integer");
  }
  const runGh = options.runGh ?? runCandidateReceiptGh;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  const deadline = Date.now() + options.timeoutMs;
  const api = (endpoint: string): Promise<unknown> =>
    retryOperation(deadline, sleep, endpoint, () =>
      parseJson(runGh(["api", `repos/${options.repo}/${endpoint}`, "--method", "GET"]), endpoint),
    );
  const workflow = await api(`actions/workflows/${options.workflowId}`);
  const workflowRecord = record(workflow, "candidate receipt workflow");
  if (
    positiveDecimal(workflowRecord.id, "candidate receipt workflow id") !== options.workflowId ||
    workflowRecord.path !== CANDIDATE_RECEIPT_WORKFLOW_PATH
  ) {
    fail("candidate receipt workflow identity does not match the canonical workflow");
  }

  const exactRun =
    options.runId && options.runAttempt
      ? { runAttempt: options.runAttempt, runId: options.runId }
      : await pollUntil(
          deadline,
          async () =>
            discoverRun(
              await api(
                `actions/workflows/${options.workflowId}/runs?event=workflow_dispatch&per_page=100`,
              ),
              {
                dispatchId: options.dispatchId,
                workflowId: options.workflowId,
                workflowSha: options.workflowSha,
              },
            ),
          sleep,
          "timed out locating the candidate receipt producer run",
        );

  const run = await pollUntil(
    deadline,
    async () => {
      const current = record(
        await api(`actions/runs/${exactRun.runId}/attempts/${exactRun.runAttempt}`),
        "candidate receipt run attempt",
      );
      if (current.status !== "completed") {
        return undefined;
      }
      if (current.conclusion !== "success") {
        fail(`candidate receipt producer concluded ${String(current.conclusion)}`);
      }
      return current;
    },
    sleep,
    "timed out waiting for the candidate receipt producer",
  );

  // A completed attempt is immutable evidence. Later reruns do not revoke it;
  // consumers revalidate this exact run, attempt, receipt, and artifact set at use.
  const receiptArtifactName = `release-candidate-receipt-${exactRun.runId}-${exactRun.runAttempt}`;
  const receiptArtifact = await pollUntil(
    deadline,
    async () => {
      const response = await api(`actions/runs/${exactRun.runId}/artifacts?per_page=100`);
      return artifactRecords(response).find((entry) => entry.name === receiptArtifactName);
    },
    sleep,
    "timed out waiting for the candidate receipt lock artifact",
  );
  validateArtifactMetadata(receiptArtifact, {
    digest: digest(receiptArtifact.digest, "candidate receipt lock artifact digest"),
    id: positiveDecimal(receiptArtifact.id, "candidate receipt lock artifact id"),
    name: receiptArtifactName,
    runId: exactRun.runId,
  });

  const downloadDir = mkdtempSync(join(tmpdir(), "openclaw-candidate-receipt-"));
  const receiptPath = join(downloadDir, RECEIPT_FILE_NAME);
  try {
    await retryOperation(deadline, sleep, "candidate receipt lock download", () => {
      rmSync(receiptPath, { force: true });
      return runGh([
        "run",
        "download",
        exactRun.runId,
        "--repo",
        options.repo,
        "--name",
        receiptArtifactName,
        "--dir",
        downloadDir,
      ]);
    });
    const parsedLock = parseCandidateReceiptLockJson(readFileSync(receiptPath, "utf8"));
    const expectedArtifactIds = new Set(
      Object.values(parsedLock.receipt.artifacts).map((artifact) => artifact.artifact_id),
    );
    const artifacts = await pollUntil(
      deadline,
      async () => {
        const response = await api(`actions/runs/${exactRun.runId}/artifacts?per_page=100`);
        const visibleArtifactIds = new Set(
          artifactRecords(response).map((artifact) =>
            positiveDecimal(artifact.id, "candidate receipt artifact id"),
          ),
        );
        return [...expectedArtifactIds].every((id) => visibleArtifactIds.has(id))
          ? response
          : undefined;
      },
      sleep,
      "timed out waiting for candidate artifact metadata propagation",
    );
    const validatedLock = validateCandidateReceiptProvenance({
      artifacts,
      expectedDispatchId: options.dispatchId,
      expectedReleasePlanDigest: options.releasePlanDigest,
      expectedRunAttempt: exactRun.runAttempt,
      expectedRunId: exactRun.runId,
      expectedWorkflowId: options.workflowId,
      expectedWorkflowSha: options.workflowSha,
      lock: parsedLock,
      run,
      workflow,
    });
    return validatedLock;
  } finally {
    rmSync(downloadDir, { force: true, recursive: true });
  }
}

function parseArgs(argv: string[]): CandidateReceiptLocatorOptions {
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === "--dispatch-id" ||
      arg === "--release-plan-digest" ||
      arg === "--repo" ||
      arg === "--run-attempt" ||
      arg === "--run-id" ||
      arg === "--timeout-seconds" ||
      arg === "--workflow-id" ||
      arg === "--workflow-sha"
    ) {
      options[arg] = argv[(index += 1)] ?? "";
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  const timeoutSeconds = options["--timeout-seconds"];
  return {
    dispatchId: options["--dispatch-id"] ?? "",
    releasePlanDigest: options["--release-plan-digest"] ?? "",
    repo: options["--repo"] ?? "",
    ...(options["--run-attempt"] ? { runAttempt: options["--run-attempt"] } : {}),
    ...(options["--run-id"] ? { runId: options["--run-id"] } : {}),
    ...(timeoutSeconds ? { timeoutMs: Number.parseInt(timeoutSeconds, 10) * 1000 } : {}),
    workflowId: options["--workflow-id"] ?? "",
    workflowSha: options["--workflow-sha"] ?? "",
  };
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const lock = await locateCandidateReceipt(parseArgs(argv));
  process.stdout.write(canonicalCandidateReceiptLockJson(lock));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[release-candidate-receipt-locator] FAILED (exit 1)");
    process.exitCode = 1;
  });
}
