#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  downloadClawHubTransactions,
  readPackedClawHubTransaction,
  validateClawHubParentAuthorization,
  validateClawHubIdentity,
  validateClawHubWorkflowRun,
} from "./clawhub-parent-authorization.mjs";
import {
  downloadExactActionsArtifactArchive,
  inspectActionsArtifactZip,
  readBoundedRegularFile,
  validateActionsArtifactBinding,
} from "./lib/actions-artifact-archive.mjs";
import { readBoundedResponseText } from "./lib/bounded-response.mjs";
import { verifyReleaseToolingIdentity } from "./release-tooling-identity.mjs";
import { verifyPublishedClawHubPackage } from "./verify-clawhub-published-artifact.mjs";

const REPOSITORY = "openclaw/openclaw";
const PARENT_WORKFLOW = ".github/workflows/openclaw-release-publish.yml";
const CHILD_WORKFLOW = ".github/workflows/plugin-clawhub-release.yml";
const MAX_RECEIPT_BYTES = 64 * 1024;

function positiveId(value, label) {
  if (!/^[1-9][0-9]*$/u.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

function requireSuccessfulRun(run, expected) {
  const actual = {
    repository: run?.repository?.full_name,
    headRepository: run?.head_repository?.full_name,
    workflow: run?.path?.split("@")[0],
    runId: run?.id,
    runAttempt: run?.run_attempt,
    headSha: run?.head_sha,
    ref: run?.head_branch,
    event: run?.event,
    status: run?.status,
    conclusion: run?.conclusion,
  };
  for (const [key, value] of Object.entries({
    repository: REPOSITORY,
    headRepository: REPOSITORY,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    ...expected,
  })) {
    if (actual[key] !== value) {
      throw new Error(`ClawHub postpublish workflow ${key} mismatch.`);
    }
  }
}

async function githubJson(path, { token, fetchImpl }) {
  const signal = AbortSignal.timeout(60_000);
  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2026-03-10",
    },
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new Error(`GitHub postpublish read returned HTTP ${response.status}.`);
  }
  return JSON.parse(
    await readBoundedResponseText(response, "GitHub postpublish", 2 * 1024 * 1024, { signal }),
  );
}

async function listRunArtifacts(runId, context) {
  const artifacts = [];
  // A full plugin release produces several artifacts per package. Bound the
  // inventory without trusting an artifact's self-declared download location.
  for (let page = 1; page <= 20; page += 1) {
    const result = await githubJson(
      `actions/runs/${runId}/artifacts?per_page=100&page=${page}`,
      context,
    );
    if (
      !Array.isArray(result.artifacts) ||
      !Number.isSafeInteger(result.total_count) ||
      result.total_count > 2000
    ) {
      throw new Error("ClawHub postpublish artifact listing is invalid or exceeds its limit.");
    }
    artifacts.push(...result.artifacts);
    if (artifacts.length === result.total_count) {
      return artifacts;
    }
    if (result.artifacts.length === 0 || artifacts.length > result.total_count) {
      break;
    }
  }
  throw new Error("ClawHub postpublish artifact listing is incomplete.");
}

async function downloadArtifact(artifact, run, context, maxArchiveBytes) {
  validateActionsArtifactBinding({
    artifactMetadata: artifact,
    workflowRun: { ...run, path: run.path.split("@")[0] },
    expected: {
      artifactId: artifact.id,
      artifactName: artifact.name,
      artifactDigest: artifact.digest,
      artifactSizeBytes: artifact.size_in_bytes,
      repository: REPOSITORY,
      runId: run.id,
      runAttempt: run.run_attempt,
      workflowSha: run.head_sha,
      workflowHeadBranch: run.head_branch,
      workflowEvent: "workflow_dispatch",
      runStatePolicy: "completed-success",
      workflowPath: run.path.split("@")[0],
    },
  });
  await mkdir(context.archiveDir, { recursive: true });
  return await downloadExactActionsArtifactArchive({
    ...context,
    archivePath: join(context.archiveDir, `${artifact.id}.zip`),
    maxArchiveBytes,
    expected: {
      repository: REPOSITORY,
      artifactId: artifact.id,
      artifactName: artifact.name,
      artifactDigest: artifact.digest,
      artifactSizeBytes: artifact.size_in_bytes,
      artifactExpiresAt: artifact.expires_at,
      runId: run.id,
      workflowSha: run.head_sha,
    },
  });
}

function identityFromReceipt(receipt) {
  return validateClawHubIdentity({
    version: 2,
    repository: REPOSITORY,
    workflow: CHILD_WORKFLOW,
    runId: String(positiveId(receipt.childRunId, "child run")),
    runAttempt: String(positiveId(receipt.childRunAttempt, "child attempt")),
    ref: receipt.childRef,
    fullRef: receipt.childFullRef,
    sha: receipt.childHeadSha,
    candidateRepository: REPOSITORY,
    candidateSha: receipt.candidateSha,
    toolingRef: receipt.toolingRef,
    toolingFullRef: receipt.toolingFullRef,
    toolingSha: receipt.toolingSha,
    parentRepository: REPOSITORY,
    parentWorkflow: PARENT_WORKFLOW,
    parentRunId: receipt.runId,
    parentRunAttempt: receipt.runAttempt,
  });
}

export async function verifyClawHubPostpublish({
  event,
  verifierSha,
  token,
  outputDir,
  fetchImpl = fetch,
  runGh,
}) {
  const trigger = event?.workflow_run;
  const runId = positiveId(trigger?.id, "parent run");
  const runAttempt = positiveId(trigger?.run_attempt, "parent attempt");
  const expectedParent = {
    workflow: PARENT_WORKFLOW,
    runId,
    runAttempt,
    headSha: trigger?.head_sha,
    ref: trigger?.head_branch,
  };
  requireSuccessfulRun(trigger, expectedParent);
  const context = { token, fetchImpl, archiveDir: join(outputDir, "archives") };
  const parent = await githubJson(`actions/runs/${runId}/attempts/${runAttempt}`, context);
  requireSuccessfulRun(parent, expectedParent);
  const artifacts = await listRunArtifacts(runId, context);
  const dispatchName = `openclaw-release-children-${runId}-${runAttempt}`;
  const dispatchArtifacts = artifacts.filter((artifact) => artifact.name === dispatchName);
  if (dispatchArtifacts.length !== 1) {
    throw new Error("Missing exact parent release dispatch record.");
  }
  const { archiveBytes: dispatchZip } = await downloadArtifact(
    dispatchArtifacts[0],
    parent,
    context,
    MAX_RECEIPT_BYTES + 4096,
  );
  const dispatchFiles = inspectActionsArtifactZip(dispatchZip, ["dispatch.json"], {
    maxEntryBytes: MAX_RECEIPT_BYTES,
    maxExpandedBytes: MAX_RECEIPT_BYTES,
  });
  const dispatch = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(dispatchFiles.get("dispatch.json")),
  );
  const dispatchFields = [
    "schemaVersion",
    "repository",
    "parentRunId",
    "parentRunAttempt",
    "parentWorkflow",
    "toolingRef",
    "toolingFullRef",
    "toolingSha",
    "candidateSha",
    "normalClawHubRunId",
    "normalClawHubRunAttempt",
  ];
  if (
    !dispatch ||
    Object.keys(dispatch).length !== dispatchFields.length ||
    dispatchFields.some((key) => !Object.hasOwn(dispatch, key)) ||
    dispatch.schemaVersion !== 1 ||
    dispatch.repository !== REPOSITORY ||
    String(dispatch.parentRunId) !== String(runId) ||
    String(dispatch.parentRunAttempt) !== String(runAttempt) ||
    dispatch.parentWorkflow !== PARENT_WORKFLOW ||
    dispatch.toolingRef !== parent.head_branch ||
    dispatch.toolingSha !== parent.head_sha ||
    !/^[a-f0-9]{40}$/u.test(dispatch.candidateSha)
  ) {
    throw new Error("Parent dispatch record identity mismatch.");
  }
  verifyReleaseToolingIdentity({
    repository: REPOSITORY,
    workflowRef: dispatch.toolingRef,
    workflowFullRef: dispatch.toolingFullRef,
    workflowSha: parent.head_sha,
    runGh,
  });
  if (!/^[a-f0-9]{40}$/u.test(verifierSha)) {
    throw new Error("Invalid trusted verifier SHA.");
  }
  const ancestry = await githubJson(`compare/${parent.head_sha}...${verifierSha}`, context);
  if (ancestry.status !== "ahead" && ancestry.status !== "identical") {
    throw new Error("Parent tooling is not an ancestor of trusted verification tooling.");
  }
  const parentQualifiedRef = parent.path.split("@")[1];
  if (parentQualifiedRef !== undefined && parentQualifiedRef !== dispatch.toolingFullRef) {
    throw new Error("Parent workflow full ref mismatch.");
  }
  await mkdir(outputDir, { recursive: true });
  if (dispatch.normalClawHubRunId === null && dispatch.normalClawHubRunAttempt === null) {
    const evidence = {
      schemaVersion: 1,
      repository: REPOSITORY,
      parentRunId: runId,
      parentRunAttempt: runAttempt,
      complete: true,
      outcome: "no-normal-clawhub-publication",
      dispatchArtifactId: dispatchArtifacts[0].id,
      dispatchArtifactDigest: dispatchArtifacts[0].digest,
      packages: [],
    };
    await writeFile(join(outputDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  }
  positiveId(dispatch.normalClawHubRunId, "dispatched child run");
  positiveId(dispatch.normalClawHubRunAttempt, "dispatched child attempt");
  const prefix = `openclaw-clawhub-parent-authorization-v2-${runId}-${runAttempt}-`;
  const receipts = artifacts.filter((artifact) => artifact.name?.startsWith(prefix));
  if (receipts.length !== 1) {
    throw new Error("Expected exactly one ClawHub parent authorization artifact for this attempt.");
  }
  const receiptArtifact = receipts[0];
  const { archiveBytes } = await downloadArtifact(
    receiptArtifact,
    parent,
    context,
    MAX_RECEIPT_BYTES + 4096,
  );
  const files = inspectActionsArtifactZip(archiveBytes, ["authorization.json"], {
    maxEntryBytes: MAX_RECEIPT_BYTES,
    maxExpandedBytes: MAX_RECEIPT_BYTES,
  });
  const receipt = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(files.get("authorization.json")),
  );
  const identity = identityFromReceipt(receipt);
  if (
    identity.runId !== String(dispatch.normalClawHubRunId) ||
    identity.runAttempt !== String(dispatch.normalClawHubRunAttempt) ||
    identity.candidateSha !== dispatch.candidateSha ||
    identity.toolingFullRef !== dispatch.toolingFullRef
  ) {
    throw new Error("Parent receipt does not bind its dispatched child.");
  }
  if (
    receiptArtifact.name !== `${prefix}${identity.runId}-${identity.runAttempt}` ||
    receipt.runId !== String(runId) ||
    receipt.runAttempt !== String(runAttempt) ||
    receipt.headSha !== parent.head_sha ||
    receipt.ref !== parent.head_branch
  ) {
    throw new Error("ClawHub parent receipt does not bind the triggering run attempt.");
  }
  let child;
  const childDeadline = Date.now() + 30 * 60 * 1000;
  for (;;) {
    child = await githubJson(
      `actions/runs/${identity.runId}/attempts/${identity.runAttempt}`,
      context,
    );
    validateClawHubWorkflowRun(child, identity);
    if (child.status === "completed") {
      break;
    }
    if (Date.now() >= childDeadline) {
      throw new Error("ClawHub child did not complete within the postpublish deadline.");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10_000);
    });
  }
  validateClawHubWorkflowRun(child, identity, { terminal: true });
  const childQualifiedRef = child.path.split("@")[1];
  if (childQualifiedRef !== undefined && childQualifiedRef !== identity.fullRef) {
    throw new Error("Child workflow full ref mismatch.");
  }
  const downloaded = await downloadClawHubTransactions({
    identity,
    ...context,
    archivePath: join(
      context.archiveDir,
      `transactions-${identity.runId}-${identity.runAttempt}.zip`,
    ),
    runGhJson: runGh
      ? (path) => JSON.parse(runGh(["api", `repos/${REPOSITORY}/${path}`, "--method", "GET"]))
      : undefined,
  });
  const transactions = downloaded.transactions;
  validateClawHubParentAuthorization(receipt, transactions);
  const childArtifacts = await listRunArtifacts(child.id, context);
  const evidence = {
    schemaVersion: 1,
    repository: REPOSITORY,
    parentRunId: runId,
    parentRunAttempt: runAttempt,
    childRunId: child.id,
    childRunAttempt: child.run_attempt,
    toolingSha: parent.head_sha,
    candidateSha: identity.candidateSha,
    dispatchArtifactId: dispatchArtifacts[0].id,
    dispatchArtifactDigest: dispatchArtifacts[0].digest,
    receiptArtifactId: receiptArtifact.id,
    receiptArtifactDigest: receiptArtifact.digest,
    packages: [],
    complete: false,
  };
  await mkdir(outputDir, { recursive: true });
  const save = () =>
    writeFile(join(outputDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  await save();
  // Registry reads carry no GitHub credentials. Each package is checked against
  // the exact bytes and inventory authorized by the successful parent.
  for (let index = 0; index < transactions.packages.length; index += 8) {
    const results = await Promise.allSettled(
      transactions.packages.slice(index, index + 8).map(async (entry) => {
        const matches = childArtifacts.filter((artifact) => artifact.name === entry.artifactName);
        if (matches.length !== 1) {
          throw new Error(`Expected one package artifact for ${entry.name}.`);
        }
        const { archiveBytes: packageZip } = await downloadArtifact(
          matches[0],
          child,
          context,
          130 * 1024 * 1024,
        );
        const packageFiles = inspectActionsArtifactZip(packageZip, 1, {
          maxEntryBytes: 120 * 1024 * 1024,
        });
        const [[fileName, bytes]] = packageFiles;
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(fileName)) {
          throw new Error("ClawHub package artifact must contain one root tarball.");
        }
        const artifactDir = join(outputDir, String(matches[0].id));
        await mkdir(artifactDir, { recursive: true });
        const tarballPath = join(artifactDir, fileName);
        try {
          await writeFile(tarballPath, bytes, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if (error?.code !== "EEXIST") {
            throw error;
          }
          // Retained output is reusable content, never publication authority.
          // Refuse modified or symlinked files instead of overwriting evidence.
          const retained = readBoundedRegularFile(tarballPath, {
            label: "Retained ClawHub package",
            maxBytes: 120 * 1024 * 1024,
          });
          if (!retained.equals(bytes)) {
            throw new Error(`Retained ClawHub package bytes mismatch: ${entry.name}.`, {
              cause: error,
            });
          }
        }
        const packed = readPackedClawHubTransaction({
          artifactDir,
          packageName: entry.name,
          version: entry.version,
          artifactName: entry.artifactName,
        });
        if (Object.keys(packed).some((key) => packed[key] !== entry[key])) {
          throw new Error(`ClawHub package transaction changed: ${entry.name}.`);
        }
        const publishTag = entry.version.includes("-alpha.")
          ? "alpha"
          : entry.version.includes("-beta.")
            ? "beta"
            : "latest";
        const verified = await verifyPublishedClawHubPackage({
          expectedArtifactDir: artifactDir,
          packageName: entry.name,
          packageVersion: entry.version,
          publishTag,
          retryOptions: { fetchImpl },
        });
        return Object.assign(verified, {
          artifactId: matches[0].id,
          artifactDigest: matches[0].digest,
          inventoryDigest: entry.inventoryDigest,
        });
      }),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        evidence.packages.push(result.value);
      }
    }
    await save();
    const failure = results.find((result) => result.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
  }
  evidence.complete = true;
  await save();
  return evidence;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await verifyClawHubPostpublish({
      event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")),
      verifierSha: process.env.VERIFIER_SHA,
      token: process.env.GH_TOKEN,
      outputDir: join(process.env.RUNNER_TEMP, "clawhub-postpublish"),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[clawhub-postpublish] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
