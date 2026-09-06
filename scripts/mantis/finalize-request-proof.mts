#!/usr/bin/env node
// Fresh trusted job only; never import or execute anything from the evidence ZIP.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  createRequestReceipt,
  requestEvidenceDigest,
  requestIdentitySchema,
  requestProofDefinitions,
  type RequestEvidence,
  type RequestExecution,
} from "./request-proof.ts";

const scenario = z
  .enum(["web-ui-chat-proof", "telegram-bot-e2e-proof", "telegram-markdown-parser-fidelity"])
  .parse(process.argv[2] ?? "web-ui-chat-proof");
const definition = requestProofDefinitions[scenario];
const identity = requestIdentitySchema.parse({
  request_id: process.env.REQUEST_ID,
  ...(process.env.PLAN_SHA256 ? { plan_sha256: process.env.PLAN_SHA256 } : {}),
  repository: { id: process.env.GITHUB_REPOSITORY_ID, full_name: process.env.GITHUB_REPOSITORY },
  pull_request: Number(process.env.TARGET_PR),
  candidate_sha: process.env.CANDIDATE_SHA,
  scenario,
  workflow: {
    path: definition.workflow,
    sha: process.env.GITHUB_WORKFLOW_SHA,
  },
  harness: { sha: process.env.GITHUB_WORKFLOW_SHA },
  run: { id: process.env.GITHUB_RUN_ID, attempt: Number(process.env.GITHUB_RUN_ATTEMPT) },
});
const token = process.env.GH_TOKEN;
if (!token) {
  throw new Error("Finalizer GitHub authentication is unavailable");
}
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};
const repo = `/repos/${identity.repository.full_name}`;
async function bytes(response: Response, maximum: number) {
  if (!response.ok || !response.body) {
    throw new Error("GitHub evidence request failed");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maximum) {
      throw new Error("GitHub response exceeded evidence limit");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function api(endpoint: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  return JSON.parse((await bytes(response, 2 * 1024 * 1024)).toString("utf8"));
}
const apiId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const attemptPath = `${repo}/actions/runs/${identity.run.id}/attempts/${identity.run.attempt}`;
const workflowBranch = process.env.GITHUB_REF?.startsWith("refs/heads/")
  ? process.env.GITHUB_REF.slice("refs/heads/".length)
  : undefined;
const run = z
  .object({
    id: apiId,
    run_attempt: z.number().int(),
    event: z.string(),
    head_sha: z.string(),
    path: z.string(),
    display_title: z.string(),
    repository: z.object({ id: apiId }),
    head_repository: z.object({ id: apiId }),
  })
  .parse(await api(attemptPath));
if (
  String(run.id) !== identity.run.id ||
  run.run_attempt !== identity.run.attempt ||
  run.event !== "workflow_dispatch" ||
  run.head_sha !== identity.workflow.sha ||
  // Only the current trusted workflow branch may qualify GitHub's run path.
  (run.path !== identity.workflow.path &&
    (!workflowBranch || run.path !== `${identity.workflow.path}@${workflowBranch}`)) ||
  run.display_title !== `${definition.runName} [${identity.request_id}]` ||
  String(run.repository.id) !== identity.repository.id ||
  String(run.head_repository.id) !== identity.repository.id
) {
  throw new Error("Workflow identity mismatch");
}
const jobs = z
  .object({
    total_count: z.number(),
    jobs: z.array(
      z.object({
        name: z.string(),
        status: z.string(),
        conclusion: z.string().nullable(),
        run_id: apiId,
        head_sha: z.string(),
      }),
    ),
  })
  .parse(await api(`${attemptPath}/jobs?per_page=100`));
const selected = jobs.jobs.filter((job) => job.name === definition.job);
const observerJob = selected[0];
if (
  jobs.total_count > 100 ||
  jobs.total_count !== jobs.jobs.length ||
  selected.length !== 1 ||
  !observerJob ||
  observerJob.status !== "completed" ||
  String(observerJob.run_id) !== identity.run.id ||
  observerJob.head_sha !== identity.workflow.sha
) {
  throw new Error("Observer job identity is missing or ambiguous");
}
const outcomes: Record<string, RequestExecution> = {
  success: "completed",
  failure: "failed",
  cancelled: "cancelled",
  timed_out: "timed_out",
  skipped: "skipped",
};
const execution = outcomes[observerJob.conclusion ?? ""] ?? "failed";
let reason: string | undefined;
const pr = z
  .object({
    state: z.string(),
    head: z.object({ sha: z.string(), repo: z.object({ id: apiId }).nullable() }),
  })
  .parse(await api(`${repo}/pulls/${identity.pull_request}`));
if (
  pr.state !== "open" ||
  pr.head.sha !== identity.candidate_sha ||
  String(pr.head.repo?.id) !== identity.repository.id
) {
  reason = "PR is no longer open at the exact same-repository candidate head.";
}
const root = path.resolve(".artifacts/mantis-request-finalizer");
mkdirSync(root, { recursive: true });
let evidence: RequestEvidence | null = null;
let files: unknown;
try {
  const name = `${definition.artifact}-${identity.run.id}-${identity.run.attempt}`;
  const artifactSchema = z.object({
    id: apiId,
    name: z.string(),
    expired: z.boolean(),
    size_in_bytes: z.number().int().positive(),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    workflow_run: z.object({
      id: apiId,
      repository_id: apiId,
      head_repository_id: apiId,
      head_sha: z.string(),
    }),
  });
  const list = z
    .object({ total_count: z.number(), artifacts: z.array(artifactSchema) })
    .parse(
      await api(
        `${repo}/actions/runs/${identity.run.id}/artifacts?per_page=100&name=${encodeURIComponent(name)}`,
      ),
    );
  if (list.total_count !== 1 || list.artifacts.length !== 1) {
    throw new Error("Missing or ambiguous artifact");
  }
  const artifact = list.artifacts[0];
  if (
    !artifact ||
    artifact.name !== name ||
    artifact.expired ||
    artifact.size_in_bytes > 16 * 1024 * 1024 ||
    String(artifact.workflow_run.id) !== identity.run.id ||
    String(artifact.workflow_run.repository_id) !== identity.repository.id ||
    String(artifact.workflow_run.head_repository_id) !== identity.repository.id ||
    artifact.workflow_run.head_sha !== identity.workflow.sha
  ) {
    throw new Error("Artifact identity mismatch");
  }
  let response = await fetch(`https://api.github.com${repo}/actions/artifacts/${artifact.id}/zip`, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 302) {
    const location = new URL(response.headers.get("location") ?? "");
    if (
      location.protocol !== "https:" ||
      location.username ||
      location.password ||
      !(
        location.hostname.endsWith(".blob.core.windows.net") ||
        location.hostname.endsWith(".actions.githubusercontent.com")
      )
    ) {
      throw new Error("Unexpected artifact storage");
    }
    // Never forward GitHub authorization to artifact storage or redirects.
    response = await fetch(location, {
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(60_000),
    });
  }
  const archive = await bytes(response, 16 * 1024 * 1024);
  const digest = requestEvidenceDigest(archive);
  if (artifact.size_in_bytes !== archive.length || artifact.digest !== `sha256:${digest}`) {
    throw new Error("Archive digest mismatch");
  }
  evidence = { artifact_id: String(artifact.id), artifact_name: name, sha256: digest };
  const archivePath = path.join(root, "evidence.zip");
  const filesPath = path.join(root, "files.json");
  writeFileSync(archivePath, archive, { flag: "wx" });
  execFileSync(
    "python3",
    [
      "-I",
      "-S",
      "scripts/mantis/read-request-archive.py",
      definition.archive,
      archivePath,
      filesPath,
    ],
    { timeout: 30_000, stdio: "pipe" },
  );
  files = JSON.parse(readFileSync(filesPath, "utf8"));
} catch {
  reason ??=
    "Evidence archive is unavailable, ambiguous, expired, malformed, unsafe, partial, or does not match its authoritative identity/digest.";
}
const receipt = createRequestReceipt(identity, execution, evidence, files, reason);
writeFileSync(path.join(root, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
  flag: "wx",
});
console.log(
  `Mantis request assertion: ${receipt.assertion_outcome}; execution: ${receipt.execution_outcome}`,
);
