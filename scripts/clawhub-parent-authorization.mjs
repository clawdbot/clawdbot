#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  downloadExactActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
  readBoundedRegularFile,
} from "./lib/actions-artifact-archive.mjs";
import { isRecord } from "./lib/record-shared.mjs";
import {
  CLAWHUB_PUBLICATION_TAR_LIMITS,
  inspectPackageTarballBytes,
} from "./plugin-publication-artifact.mjs";
import { runReleaseToolingGh, verifyReleaseToolingIdentity } from "./release-tooling-identity.mjs";

export const CLAWHUB_PARENT_WORKFLOW = ".github/workflows/openclaw-release-publish.yml";
export const CLAWHUB_CHILD_WORKFLOW = ".github/workflows/plugin-clawhub-release.yml";
export const CLAWHUB_TRANSACTIONS_JOB = "Seal ClawHub package transactions";
const REPOSITORY = "openclaw/openclaw";
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^[1-9][0-9]*$/u;
const PACKAGE = /^@openclaw\/[a-z0-9][a-z0-9._-]*$/u;
const VERSION =
  /^[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:-(?:alpha|beta)\.[1-9][0-9]*|-[1-9][0-9]*)?$/u;
const ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_PARENT_BYTES = 64 * 1024;
const IDENTITY_KEYS =
  "version repository workflow runId runAttempt ref fullRef sha candidateRepository candidateSha toolingRef toolingFullRef toolingSha parentRepository parentWorkflow parentRunId parentRunAttempt".split(
    " ",
  );
const TRANSACTION_KEYS =
  "name version inventoryDigest artifactName artifactSha256 artifactSize".split(" ");

export class ClawHubTransactionsPending extends Error {}

function exactKeys(value, keys, label) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} fields are invalid.`);
  }
}
function pattern(value, expression, label) {
  if (typeof value !== "string" || !expression.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
function readJson(path, maxBytes = MAX_JSON_BYTES) {
  return JSON.parse(readBoundedRegularFile(path, { label: path, maxBytes }).toString("utf8"));
}
function same(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} mismatch.`);
  }
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function refIdentity(ref, fullRef, sha) {
  pattern(sha, SHA, "Workflow SHA");
  if (fullRef === "refs/heads/main" && ref === "main") {
    return;
  }
  if (
    !/^release-publish\/[a-f0-9]{12}-[1-9][0-9]*$/u.test(ref) ||
    fullRef !== `refs/tags/${ref}` ||
    !ref.startsWith(`release-publish/${sha.slice(0, 12)}-`)
  ) {
    throw new Error("ClawHub tooling must use main or an exact protected release-publish tag.");
  }
}

export function validateClawHubIdentity(value) {
  exactKeys(value, IDENTITY_KEYS, "ClawHub v2 identity");
  if (
    value.version !== 2 ||
    value.repository !== REPOSITORY ||
    value.candidateRepository !== REPOSITORY ||
    value.parentRepository !== REPOSITORY ||
    value.workflow !== CLAWHUB_CHILD_WORKFLOW ||
    value.parentWorkflow !== CLAWHUB_PARENT_WORKFLOW
  ) {
    throw new Error("ClawHub v2 identity repository or workflow mismatch.");
  }
  for (const key of ["runId", "runAttempt", "parentRunId", "parentRunAttempt"]) {
    pattern(value[key], ID, key);
  }
  pattern(value.candidateSha, SHA, "Candidate SHA");
  refIdentity(value.ref, value.fullRef, value.sha);
  refIdentity(value.toolingRef, value.toolingFullRef, value.toolingSha);
  if (value.sha !== value.toolingSha) {
    throw new Error("Child execution must match the approving parent tooling SHA.");
  }
  return value;
}

export function clawHubIdentityFromEnvironment(env) {
  const identity = validateClawHubIdentity({
    version: 2,
    repository: env.GITHUB_REPOSITORY,
    workflow: CLAWHUB_CHILD_WORKFLOW,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    ref: env.GITHUB_REF_NAME,
    fullRef: env.GITHUB_REF,
    sha: env.GITHUB_WORKFLOW_SHA,
    candidateRepository: env.GITHUB_REPOSITORY,
    candidateSha: env.TARGET_SHA,
    toolingRef: env.RELEASE_PUBLISH_BRANCH,
    toolingFullRef: env.RELEASE_PUBLISH_FULL_REF,
    toolingSha: env.RELEASE_PUBLISH_WORKFLOW_SHA,
    parentRepository: env.GITHUB_REPOSITORY,
    parentWorkflow: CLAWHUB_PARENT_WORKFLOW,
    parentRunId: env.RELEASE_PUBLISH_RUN_ID,
    parentRunAttempt: env.RELEASE_PUBLISH_RUN_ATTEMPT,
  });
  if (
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/${CLAWHUB_CHILD_WORKFLOW}@${identity.fullRef}`
  ) {
    throw new Error("ClawHub identity does not match the executing workflow context.");
  }
  return identity;
}

// actions/download-artifact writes a lone `pattern` match straight into `path`
// instead of `path/<artifact>`, so a one-package matrix must read the flat
// layout; anything else keeps the per-artifact directory contract.
export function resolvePackedClawHubArtifactDir({ directory, artifactName, matrixSize }) {
  const nested = join(directory, artifactName);
  if (existsSync(nested) || matrixSize !== 1) {
    return nested;
  }
  return directory;
}

export function readPackedClawHubTransaction({ artifactDir, packageName, version, artifactName }) {
  pattern(packageName, PACKAGE, "Package name");
  pattern(version, VERSION, "Package version");
  pattern(artifactName, ARTIFACT, "Package artifact name");
  const files = readdirSync(artifactDir, { withFileTypes: true });
  if (files.length !== 1 || !files[0].isFile() || !files[0].name.endsWith(".tgz")) {
    throw new Error("Expected one regular ClawHub tarball.");
  }
  const bytes = readBoundedRegularFile(join(artifactDir, files[0].name), {
    label: "ClawHub tarball",
    maxBytes: CLAWHUB_PUBLICATION_TAR_LIMITS.maxArchiveBytes,
  });
  const inspected = inspectPackageTarballBytes(bytes, CLAWHUB_PUBLICATION_TAR_LIMITS);
  if (
    inspected.packageManifest.name !== packageName ||
    inspected.packageManifest.version !== version
  ) {
    throw new Error("Packed ClawHub package identity mismatch.");
  }
  // Match ClawHub's hashSkillFiles/buildGitHubFolderContentHash contract:
  // package-relative regular files, locale-sorted paths, NUL-separated fields.
  const payload = inspected.inventory
    .filter((entry) => entry.type === "file")
    .map((entry) => ({
      path: entry.path.slice("package/".length),
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
    }))
    .toSorted((a, b) => a.path.localeCompare(b.path))
    .map((entry) => `${entry.path}\0${entry.sizeBytes}\0${entry.sha256}`)
    .join("\n");
  return {
    name: packageName,
    version,
    inventoryDigest: sha256(payload),
    artifactName,
    artifactSha256: inspected.tarballSha256,
    artifactSize: inspected.tarballSizeBytes,
  };
}

export function validateClawHubTransactions(value, expectedIdentity) {
  exactKeys(value, ["schemaVersion", "identity", "packages"], "ClawHub transactions");
  if (value.schemaVersion !== 1) {
    throw new Error("Unsupported ClawHub transactions schema.");
  }
  const identity = validateClawHubIdentity(value.identity);
  if (expectedIdentity) {
    for (const key of IDENTITY_KEYS) {
      same(identity[key], expectedIdentity[key], `Transaction identity ${key}`);
    }
  }
  if (
    !Array.isArray(value.packages) ||
    value.packages.length === 0 ||
    value.packages.length > 512
  ) {
    throw new Error("Invalid ClawHub transaction count.");
  }
  const names = new Set();
  const artifacts = new Set();
  for (const entry of value.packages) {
    exactKeys(entry, TRANSACTION_KEYS, "ClawHub package transaction");
    pattern(entry.name, PACKAGE, "Package name");
    pattern(entry.version, VERSION, "Package version");
    pattern(entry.inventoryDigest, DIGEST, "Package inventory digest");
    pattern(entry.artifactSha256, DIGEST, "Package archive digest");
    pattern(entry.artifactName, ARTIFACT, "Package artifact name");
    if (
      !Number.isSafeInteger(entry.artifactSize) ||
      entry.artifactSize < 1 ||
      entry.artifactSize > CLAWHUB_PUBLICATION_TAR_LIMITS.maxArchiveBytes ||
      names.has(entry.name) ||
      artifacts.has(entry.artifactName)
    ) {
      throw new Error("Duplicate or oversized ClawHub transaction.");
    }
    names.add(entry.name);
    artifacts.add(entry.artifactName);
  }
  same(
    value.packages.map((entry) => entry.name),
    [...names].toSorted((a, b) => a.localeCompare(b)),
    "Transaction ordering",
  );
  return value;
}

export function clawHubTransactionsArtifactName(identity) {
  validateClawHubIdentity(identity);
  return `openclaw-clawhub-transactions-${identity.runId}-${identity.runAttempt}`;
}
export function clawHubParentArtifactName(identity) {
  validateClawHubIdentity(identity);
  return `openclaw-clawhub-parent-authorization-v2-${identity.parentRunId}-${identity.parentRunAttempt}-${identity.runId}-${identity.runAttempt}`;
}
export function createClawHubParentAuthorization(transactions, authorizationRoute) {
  const { identity: i, packages } = validateClawHubTransactions(transactions);
  if (!["automated-awaited", "automated-detached"].includes(authorizationRoute)) {
    throw new Error("Unsupported ClawHub authorization route.");
  }
  const receipt = {
    version: 2,
    kind: "openclaw-clawhub-parent-authorization",
    repository: i.parentRepository,
    workflow: i.parentWorkflow,
    runId: i.parentRunId,
    runAttempt: i.parentRunAttempt,
    ref: i.toolingRef,
    fullRef: i.toolingFullRef,
    headSha: i.toolingSha,
    childRepository: i.repository,
    childWorkflow: i.workflow,
    childRunId: i.runId,
    childRunAttempt: i.runAttempt,
    childRef: i.ref,
    childFullRef: i.fullRef,
    childHeadSha: i.sha,
    candidateRepository: i.candidateRepository,
    candidateSha: i.candidateSha,
    toolingRef: i.toolingRef,
    toolingFullRef: i.toolingFullRef,
    toolingSha: i.toolingSha,
    authorizationRoute,
    packages: packages.map(({ name, version, inventoryDigest }) => ({
      name,
      version,
      inventoryDigest,
    })),
  };
  if (Buffer.byteLength(JSON.stringify(receipt)) > MAX_PARENT_BYTES) {
    throw new Error("ClawHub parent authorization exceeds 64 KiB.");
  }
  return receipt;
}
export function validateClawHubParentAuthorization(receipt, transactions) {
  const expected = createClawHubParentAuthorization(transactions, receipt?.authorizationRoute);
  exactKeys(receipt, Object.keys(expected), "ClawHub parent authorization");
  for (const key of Object.keys(expected)) {
    same(receipt[key], expected[key], `Parent authorization ${key}`);
  }
  return receipt;
}

export function validateClawHubWorkflowRun(
  run,
  identity,
  { parent = false, terminal = false } = {},
) {
  validateClawHubIdentity(identity);
  const expected = parent
    ? {
        id: identity.parentRunId,
        attempt: identity.parentRunAttempt,
        workflow: identity.parentWorkflow,
        ref: identity.toolingRef,
        sha: identity.toolingSha,
      }
    : {
        id: identity.runId,
        attempt: identity.runAttempt,
        workflow: identity.workflow,
        ref: identity.ref,
        sha: identity.sha,
      };
  if (
    !isRecord(run) ||
    String(run.id) !== expected.id ||
    String(run.run_attempt) !== expected.attempt ||
    run.repository?.full_name !== REPOSITORY ||
    run.head_repository?.full_name !== REPOSITORY ||
    run.event !== "workflow_dispatch" ||
    String(run.path).split("@")[0] !== expected.workflow ||
    run.head_sha !== expected.sha ||
    run.head_branch !== expected.ref
  ) {
    throw new Error("ClawHub workflow identity mismatch.");
  }
  const qualifiedRef = run.path.split("@")[1];
  if (
    qualifiedRef !== undefined &&
    qualifiedRef !== (parent ? identity.toolingFullRef : identity.fullRef)
  ) {
    throw new Error("ClawHub workflow full ref mismatch.");
  }
  const active =
    ["queued", "pending", "waiting", "in_progress"].includes(run.status) && run.conclusion === null;
  const success = run.status === "completed" && run.conclusion === "success";
  if (!(terminal ? success : active || success)) {
    throw new Error("ClawHub workflow is not in an authorized state.");
  }
  return run;
}
function api(path) {
  const raw = runReleaseToolingGh(["api", `repos/${REPOSITORY}/${path}`, "--method", "GET"]);
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) {
    throw new Error("GitHub metadata exceeds limit.");
  }
  return JSON.parse(raw);
}
export async function downloadClawHubTransactions({ identity, token, runGhJson = api, fetchImpl }) {
  validateClawHubIdentity(identity);
  const run = validateClawHubWorkflowRun(
    runGhJson(`actions/runs/${identity.runId}/attempts/${identity.runAttempt}`),
    identity,
  );
  const name = clawHubTransactionsArtifactName(identity);
  const listed = runGhJson(`actions/runs/${identity.runId}/artifacts?name=${name}&per_page=100`);
  if (listed.total_count === 0 && listed.artifacts?.length === 0 && run.status !== "completed") {
    throw new ClawHubTransactionsPending("ClawHub transactions are not sealed yet.");
  }
  if (listed.total_count !== 1 || listed.artifacts?.length !== 1) {
    throw new Error("Exact ClawHub transaction artifact is missing or ambiguous.");
  }
  const artifact = listed.artifacts[0];
  {
    const jobs = [];
    for (let page = 1; page <= 20; page++) {
      const response = runGhJson(
        `actions/runs/${identity.runId}/attempts/${identity.runAttempt}/jobs?per_page=100&page=${page}`,
      );
      if (
        !Array.isArray(response.jobs) ||
        !Number.isSafeInteger(response.total_count) ||
        response.total_count > 2000
      ) {
        throw new Error("Invalid ClawHub producer job inventory.");
      }
      jobs.push(...response.jobs);
      if (jobs.length >= response.total_count) {
        if (jobs.length !== response.total_count) {
          throw new Error("Inconsistent ClawHub job inventory.");
        }
        break;
      }
      if (page === 20) {
        throw new Error("Incomplete ClawHub producer job inventory.");
      }
    }
    const matches = jobs.filter((job) => job.name === CLAWHUB_TRANSACTIONS_JOB);
    if (
      matches.length !== 1 ||
      String(matches[0].run_id) !== identity.runId ||
      String(matches[0].run_attempt) !== identity.runAttempt ||
      matches[0].head_sha !== identity.sha
    ) {
      throw new Error("ClawHub transaction producer identity mismatch.");
    }
    if (matches[0].status !== "completed" && run.status !== "completed") {
      throw new ClawHubTransactionsPending("ClawHub transaction producer is still completing.");
    }
    if (matches[0].status !== "completed" || matches[0].conclusion !== "success") {
      throw new Error("ClawHub transaction producer did not complete successfully.");
    }
  }
  const { archiveBytes, artifactMetadata } = await downloadExactActionsArtifactArchive({
    expected: {
      repository: REPOSITORY,
      artifactId: artifact.id,
      artifactName: name,
      artifactDigest: artifact.digest,
      artifactSizeBytes: artifact.size_in_bytes,
      artifactExpiresAt: artifact.expires_at,
      runId: Number(identity.runId),
      workflowSha: identity.sha,
    },
    token,
    fetchImpl,
    maxArchiveBytes: MAX_JSON_BYTES,
    retryAttempts: 1,
  });
  const files = inspectActionsArtifactZipWithPolicy(archiveBytes, {
    expectedEntries: ["transactions.json"],
    maxArchiveBytes: MAX_JSON_BYTES,
    maxExpandedBytes: MAX_JSON_BYTES,
    maxEntryBytes: () => MAX_JSON_BYTES,
  });
  const transactions = validateClawHubTransactions(
    JSON.parse(files.get("transactions.json").toString("utf8")),
    identity,
  );
  return { transactions, artifactMetadata, run };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: "string" },
      matrix: { type: "string" },
      directory: { type: "string" },
      "child-run": { type: "string" },
      plan: { type: "string" },
    },
  });
  let result;
  if (positionals[0] === "seal") {
    const identity = clawHubIdentityFromEnvironment(process.env);
    const matrix = readJson(values.matrix);
    if (!Array.isArray(matrix) || matrix.length === 0 || matrix.length > 512) {
      throw new Error("Invalid ClawHub package matrix.");
    }
    const packages = matrix
      .map((entry) =>
        readPackedClawHubTransaction({
          artifactDir: resolvePackedClawHubArtifactDir({
            directory: values.directory,
            artifactName: pattern(entry.artifactName, ARTIFACT, "Artifact name"),
            matrixSize: matrix.length,
          }),
          artifactName: entry.artifactName,
          packageName: entry.packageName,
          version: entry.version,
        }),
      )
      .toSorted((a, b) => a.name.localeCompare(b.name));
    result = validateClawHubTransactions({ schemaVersion: 1, identity, packages });
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `identity=${JSON.stringify(identity)}\nartifact_name=${clawHubTransactionsArtifactName(identity)}\n`,
    );
  } else if (positionals[0] === "authorize") {
    const env = process.env;
    const plan = readJson(values.plan);
    const childRef = plan.normal.ref;
    const childFullRef = childRef === "main" ? "refs/heads/main" : `refs/tags/${childRef}`;
    const identity = validateClawHubIdentity({
      version: 2,
      repository: env.GITHUB_REPOSITORY,
      workflow: CLAWHUB_CHILD_WORKFLOW,
      runId: values["child-run"],
      runAttempt: "1",
      ref: childRef,
      fullRef: childFullRef,
      sha: env.GITHUB_WORKFLOW_SHA,
      candidateRepository: env.GITHUB_REPOSITORY,
      candidateSha: env.TARGET_SHA,
      toolingRef: env.GITHUB_REF_NAME,
      toolingFullRef: env.GITHUB_REF,
      toolingSha: env.GITHUB_WORKFLOW_SHA,
      parentRepository: env.GITHUB_REPOSITORY,
      parentWorkflow: CLAWHUB_PARENT_WORKFLOW,
      parentRunId: env.GITHUB_RUN_ID,
      parentRunAttempt: env.GITHUB_RUN_ATTEMPT,
    });
    if (
      env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_WORKFLOW_REF !==
        `${REPOSITORY}/${CLAWHUB_PARENT_WORKFLOW}@${identity.toolingFullRef}`
    ) {
      throw new Error("Authorization must be produced by the executing release parent.");
    }
    const names = plan.normal.packages.toSorted((a, b) => a.localeCompare(b));
    const deadline = Date.now() + 45 * 60 * 1000;
    let transactions;
    for (;;) {
      validateClawHubWorkflowRun(api(`actions/runs/${identity.parentRunId}`), identity, {
        parent: true,
      });
      validateClawHubWorkflowRun(api(`actions/runs/${identity.runId}`), identity);
      try {
        ({ transactions } = await downloadClawHubTransactions({ identity, token: env.GH_TOKEN }));
        break;
      } catch (error) {
        if (!(error instanceof ClawHubTransactionsPending)) {
          throw error;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "ClawHub transaction preparation did not complete within the release deadline.",
        );
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 10000);
      });
    }
    same(
      transactions.packages.map((entry) => entry.name),
      names,
      "Approved ClawHub package selection",
    );
    if (
      transactions.packages.some((entry) => entry.version !== env.RELEASE_TAG?.replace(/^v/u, ""))
    ) {
      throw new Error("ClawHub transactions differ from the approved release version.");
    }
    verifyReleaseToolingIdentity({
      repository: REPOSITORY,
      workflowRef: identity.toolingRef,
      workflowFullRef: identity.toolingFullRef,
      workflowSha: identity.toolingSha,
    });
    validateClawHubWorkflowRun(api(`actions/runs/${identity.parentRunId}`), identity, {
      parent: true,
    });
    validateClawHubWorkflowRun(api(`actions/runs/${identity.runId}`), identity);
    result = createClawHubParentAuthorization(
      transactions,
      env.WAIT_FOR_CLAWHUB === "true" ? "automated-awaited" : "automated-detached",
    );
    appendFileSync(env.GITHUB_OUTPUT, `artifact_name=${clawHubParentArtifactName(identity)}\n`);
  } else {
    throw new Error("Expected seal or authorize.");
  }
  mkdirSync(dirname(values.output), { recursive: true });
  writeFileSync(values.output, `${JSON.stringify(result)}\n`, { flag: "wx" });
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
