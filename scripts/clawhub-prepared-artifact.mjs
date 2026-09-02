#!/usr/bin/env node

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  CLAWHUB_CHILD_WORKFLOW,
  readPackedClawHubTransaction,
} from "./clawhub-parent-authorization.mjs";
import {
  downloadExactActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
  readBoundedRegularFile,
  validateActionsArtifactBinding,
  validateActionsArtifactProducerJob,
} from "./lib/actions-artifact-archive.mjs";
import { readBoundedResponseText } from "./lib/bounded-response.mjs";
import { isRecord } from "./lib/record-shared.mjs";
import { runReleaseToolingGh, verifyReleaseToolingIdentity } from "./release-tooling-identity.mjs";

const REPOSITORY = "openclaw/openclaw";
const MANIFEST_FILE = "prepared-clawhub.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 120 * 1024 * 1024;
const MAX_PACKAGE_ZIP_BYTES = 130 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const VERSION =
  /^[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:-(?:alpha|beta)\.[1-9][0-9]*|-[1-9][0-9]*)?$/u;
const PRODUCER_KEYS =
  "repository runId runAttempt workflowPath workflowEvent workflowHeadBranch workflowSha".split(
    " ",
  );
const ARTIFACT_KEYS = "artifactId artifactName artifactDigest artifactSizeBytes".split(" ");
const PACKAGE_KEYS =
  "packageName packageDir version publishTag tarballName tarballSha256 tarballSizeBytes inventoryDigest".split(
    " ",
  );

function exactKeys(value, keys, label) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} fields are invalid.`);
  }
}
function matches(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
function positive(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} is invalid.`);
  }
}
function same(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} mismatch.`);
  }
}
function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
function producerFullRef(producer) {
  if (producer.workflowHeadBranch === "main") {
    return "refs/heads/main";
  }
  const ref = matches(
    producer.workflowHeadBranch,
    /^release-publish\/[a-f0-9]{12}-[1-9][0-9]*$/u,
    "Prepared ClawHub tooling ref",
  );
  if (!ref.startsWith(`release-publish/${producer.workflowSha.slice(0, 12)}-`)) {
    throw new Error("Prepared ClawHub tooling ref does not match its SHA.");
  }
  return `refs/tags/${ref}`;
}
function validateProducer(value) {
  exactKeys(value, PRODUCER_KEYS, "Prepared ClawHub producer");
  if (
    value.repository !== REPOSITORY ||
    value.workflowPath !== CLAWHUB_CHILD_WORKFLOW ||
    value.workflowEvent !== "workflow_dispatch"
  ) {
    throw new Error("Prepared ClawHub producer repository or workflow mismatch.");
  }
  positive(value.runId, Number.MAX_SAFE_INTEGER, "Prepared ClawHub run ID");
  positive(value.runAttempt, Number.MAX_SAFE_INTEGER, "Prepared ClawHub run attempt");
  matches(value.workflowSha, SHA, "Prepared ClawHub tooling SHA");
  producerFullRef(value);
  return value;
}
function validateArtifact(value) {
  positive(value.artifactId, Number.MAX_SAFE_INTEGER, "Prepared ClawHub artifact ID");
  positive(value.artifactSizeBytes, MAX_PACKAGE_ZIP_BYTES, "Prepared ClawHub artifact size");
  matches(value.artifactName, ARTIFACT, "Prepared ClawHub artifact name");
  matches(value.artifactDigest, /^sha256:[a-f0-9]{64}$/u, "Prepared ClawHub artifact digest");
}
function validateDescriptor(value, toolingSha) {
  exactKeys(value, [...PRODUCER_KEYS, ...ARTIFACT_KEYS], "Prepared ClawHub artifact descriptor");
  validateProducer(pick(value, PRODUCER_KEYS));
  validateArtifact(value);
  if (toolingSha !== undefined) {
    same(value.workflowSha, toolingSha, "Prepared ClawHub tooling SHA");
  }
  return value;
}
function selectionEntry(entry) {
  matches(entry.packageName, /^@openclaw\/[a-z0-9][a-z0-9._-]*$/u, "Prepared ClawHub package name");
  matches(
    entry.packageDir,
    /^extensions\/[a-z0-9][a-z0-9._-]*$/u,
    "Prepared ClawHub package directory",
  );
  matches(entry.version, VERSION, "Prepared ClawHub package version");
  matches(entry.publishTag, /^(alpha|beta|latest)$/u, "Prepared ClawHub publication tag");
  return pick(entry, ["packageName", "packageDir", "version", "publishTag"]);
}
function validatePackage(entry) {
  exactKeys(entry, [...PACKAGE_KEYS, ...ARTIFACT_KEYS], "Prepared ClawHub package");
  selectionEntry(entry);
  validateArtifact(entry);
  matches(entry.tarballName, /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u, "Prepared ClawHub tarball name");
  matches(entry.tarballSha256, DIGEST, "Prepared ClawHub tarball digest");
  matches(entry.inventoryDigest, DIGEST, "Prepared ClawHub inventory digest");
  positive(entry.tarballSizeBytes, MAX_PACKAGE_BYTES, "Prepared ClawHub tarball size");
  return entry;
}
function orderedSelection(matrix) {
  if (!Array.isArray(matrix) || matrix.length > 512) {
    throw new Error("Prepared ClawHub package selection is invalid.");
  }
  const selection = matrix
    .map(selectionEntry)
    .toSorted((left, right) => left.packageName.localeCompare(right.packageName));
  if (new Set(selection.map((entry) => entry.packageName)).size !== selection.length) {
    throw new Error("Prepared ClawHub package selection contains duplicates.");
  }
  return selection;
}
function preparedPackageArtifactName(entry, producer) {
  const packageName = entry.packageName.slice(1).replace("/", "-");
  return `clawhub-package-${packageName}-${entry.version}-${producer.runId}-${producer.runAttempt}`;
}
export function preparedClawHubArtifactName(candidateSha, producer) {
  matches(candidateSha, SHA, "Prepared ClawHub candidate SHA");
  validateProducer(producer);
  return `clawhub-prepared-${candidateSha.slice(0, 12)}-${producer.runId}-${producer.runAttempt}`;
}
export function validatePreparedClawHubManifest(value, { descriptor, candidateSha }) {
  exactKeys(
    value,
    ["schemaVersion", "kind", "candidateSha", "producer", "selectionMode", "packages"],
    "Prepared ClawHub manifest",
  );
  if (value.schemaVersion !== 1 || value.kind !== "openclaw-clawhub-prepared") {
    throw new Error("Unsupported prepared ClawHub manifest.");
  }
  matches(value.selectionMode, /^(selected|all-publishable)$/u, "Prepared ClawHub selection mode");
  validateDescriptor(descriptor);
  matches(value.candidateSha, SHA, "Prepared ClawHub candidate SHA");
  same(value.candidateSha, candidateSha, "Prepared ClawHub candidate SHA");
  validateProducer(value.producer);
  same(value.producer, pick(descriptor, PRODUCER_KEYS), "Prepared ClawHub producer");
  same(
    descriptor.artifactName,
    preparedClawHubArtifactName(candidateSha, value.producer),
    "Prepared ClawHub manifest artifact name",
  );
  if (!Array.isArray(value.packages) || value.packages.length > 512) {
    throw new Error("Prepared ClawHub manifest package count is invalid.");
  }
  value.packages.forEach((entry) => {
    validatePackage(entry);
    same(
      entry.artifactName,
      preparedPackageArtifactName(entry, value.producer),
      "Prepared ClawHub package artifact producer attempt",
    );
  });
  const selection = orderedSelection(value.packages);
  same(
    value.packages.map((entry) => entry.packageName),
    selection.map((entry) => entry.packageName),
    "Prepared ClawHub package order",
  );
  if (
    new Set(value.packages.map((entry) => entry.artifactId)).size !== value.packages.length ||
    new Set(value.packages.map((entry) => entry.artifactName)).size !== value.packages.length
  ) {
    throw new Error("Prepared ClawHub package artifacts are duplicated.");
  }
  return value;
}

function api(path) {
  const raw = runReleaseToolingGh(["api", `repos/${REPOSITORY}/${path}`, "--method", "GET"]);
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) {
    throw new Error("Prepared ClawHub GitHub metadata exceeds its limit.");
  }
  return JSON.parse(raw);
}
function verifyProducerTooling(producer, runGhJson) {
  verifyReleaseToolingIdentity({
    repository: REPOSITORY,
    workflowRef: producer.workflowHeadBranch,
    workflowFullRef: producerFullRef(producer),
    workflowSha: producer.workflowSha,
    runGh: (args) => JSON.stringify(runGhJson(args[1].replace(`repos/${REPOSITORY}/`, ""))),
  });
}
function workflowRunForProducer(run, producer) {
  const [workflowPath, ...qualifiedRef] = String(run.path).split("@");
  if (qualifiedRef.length > 0 && qualifiedRef.join("@") !== producerFullRef(producer)) {
    throw new Error("Prepared ClawHub producer full ref mismatch.");
  }
  return { ...run, path: workflowPath };
}
async function downloadBoundArtifact({
  descriptor,
  token,
  fetchImpl,
  runGhJson = api,
  maxBytes,
  archivePath,
}) {
  validateDescriptor(descriptor);
  const run = runGhJson(`actions/runs/${descriptor.runId}/attempts/${descriptor.runAttempt}`);
  const artifact = runGhJson(`actions/artifacts/${descriptor.artifactId}`);
  validateActionsArtifactBinding({
    expected: { ...descriptor, runStatePolicy: "completed-success" },
    artifactMetadata: artifact,
    workflowRun: workflowRunForProducer(run, descriptor),
  });
  return await downloadExactActionsArtifactArchive({
    expected: { ...descriptor, artifactExpiresAt: artifact.expires_at },
    token,
    fetchImpl,
    archivePath,
    maxArchiveBytes: maxBytes,
  });
}
export async function downloadPreparedClawHubRelease(options) {
  const {
    descriptor,
    candidateSha,
    toolingSha,
    selectionMode,
    plugins,
    token,
    fetchImpl,
    runGhJson = api,
    archivePath,
  } = options;
  validateDescriptor(descriptor, toolingSha);
  verifyProducerTooling(descriptor, runGhJson);
  const { archiveBytes } = await downloadBoundArtifact({
    descriptor,
    token,
    fetchImpl,
    runGhJson,
    archivePath,
    maxBytes: MAX_MANIFEST_BYTES,
  });
  const files = inspectActionsArtifactZipWithPolicy(archiveBytes, {
    expectedEntries: [MANIFEST_FILE],
    maxArchiveBytes: MAX_MANIFEST_BYTES,
    maxExpandedBytes: MAX_MANIFEST_BYTES,
    maxEntryBytes: () => MAX_MANIFEST_BYTES,
  });
  const manifest = validatePreparedClawHubManifest(
    JSON.parse(files.get(MANIFEST_FILE).toString("utf8")),
    { descriptor, candidateSha },
  );
  matches(selectionMode, /^(selected|all-publishable)$/u, "Requested ClawHub selection mode");
  same(manifest.selectionMode, selectionMode, "Prepared ClawHub selection mode");
  const requested = (
    typeof plugins === "string" ? plugins.split(",").filter(Boolean) : (plugins ?? [])
  )
    .map((name) => matches(name, /^@openclaw\/[a-z0-9][a-z0-9._-]*$/u, "Requested ClawHub package"))
    .toSorted((left, right) => left.localeCompare(right));
  if (selectionMode === "all-publishable") {
    if (requested.length > 0) {
      throw new Error("All-publishable ClawHub promotion must not narrow the prepared selection.");
    }
  } else {
    same(
      requested,
      manifest.packages.map((entry) => entry.packageName),
      "Prepared ClawHub full package selection",
    );
  }
  return manifest;
}
async function preparedPackageIsPublished(entry, fetchImpl) {
  const packageUrl = `https://clawhub.ai/api/v1/packages/${encodeURIComponent(entry.packageName)}`;
  const publisherRepair =
    "Complete bootstrap or trusted-publisher repair through the existing Plugin ClawHub New owner before preparing again.";
  const signal = AbortSignal.timeout(30_000);
  const publisherResponse = await fetchImpl(`${packageUrl}/trusted-publisher`, { signal });
  if (!publisherResponse.ok) {
    await publisherResponse.body?.cancel().catch(() => undefined);
    throw new Error(
      `Prepared ClawHub trusted publisher is unavailable for ${entry.packageName}: HTTP ${publisherResponse.status}.${publisherResponse.status === 404 ? ` ${publisherRepair}` : ""}`,
    );
  }
  const publisher = JSON.parse(
    await readBoundedResponseText(
      publisherResponse,
      "Prepared ClawHub trusted publisher",
      64 * 1024,
      { signal },
    ),
  ).trustedPublisher;
  if (
    publisher?.provider !== "github-actions" ||
    publisher?.repository !== REPOSITORY ||
    publisher?.workflowFilename !== "plugin-clawhub-release.yml" ||
    publisher?.environment != null
  ) {
    throw new Error(
      `Prepared ClawHub trusted publisher is missing or mismatched for ${entry.packageName}. ${publisherRepair}`,
    );
  }
  const response = await fetchImpl(`${packageUrl}/versions/${encodeURIComponent(entry.version)}`, {
    signal,
  });
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 404) {
    return false;
  }
  if (response.status === 200) {
    return true;
  }
  throw new Error(
    `Cannot resolve prepared ClawHub version ${entry.packageName}@${entry.version}: HTTP ${response.status}.`,
  );
}
export async function resolvePreparedClawHubMatrix(options) {
  const manifest = await downloadPreparedClawHubRelease(options);
  const matrix = [];
  for (let index = 0; index < manifest.packages.length; index += 8) {
    const entries = await Promise.allSettled(
      manifest.packages.slice(index, index + 8).map(async (entry) =>
        Object.assign(selectionEntry(entry), {
          artifactName: entry.artifactName,
          alreadyPublished: await preparedPackageIsPublished(entry, options.fetchImpl ?? fetch),
          prepared: entry,
        }),
      ),
    );
    for (const result of entries) {
      if (result.status === "fulfilled") {
        matrix.push(result.value);
      }
    }
    const failure = entries.find((result) => result.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
  }
  return matrix;
}
function expectedTransaction(entry, artifactName) {
  return {
    name: entry.packageName,
    version: entry.version,
    inventoryDigest: entry.inventoryDigest,
    artifactName,
    artifactSha256: entry.tarballSha256,
    artifactSize: entry.tarballSizeBytes,
  };
}
function verifyRestoredPackage(directory, entry, artifactName) {
  const actual = readPackedClawHubTransaction({
    artifactDir: directory,
    packageName: entry.packageName,
    version: entry.version,
    artifactName,
  });
  same(
    actual,
    expectedTransaction(entry, artifactName),
    "Restored ClawHub package bytes and inventory",
  );
}
export async function restorePreparedClawHubPackage(options) {
  const { descriptor, entry, outputDir, token, fetchImpl, runGhJson = api } = options;
  validateDescriptor(descriptor, options.toolingSha);
  validatePackage(entry);
  const artifactName = options.artifactName ?? entry.artifactName;
  matches(artifactName, ARTIFACT, "Restored ClawHub artifact name");
  verifyProducerTooling(descriptor, runGhJson);
  const source = { ...pick(descriptor, PRODUCER_KEYS), ...pick(entry, ARTIFACT_KEYS) };
  mkdirSync(dirname(outputDir), { recursive: true });
  const { archiveBytes } = await downloadBoundArtifact({
    descriptor: source,
    token,
    fetchImpl,
    runGhJson,
    archivePath: options.archivePath,
    maxBytes: MAX_PACKAGE_ZIP_BYTES,
  });
  const files = inspectActionsArtifactZipWithPolicy(archiveBytes, {
    expectedEntries: [entry.tarballName],
    maxArchiveBytes: MAX_PACKAGE_ZIP_BYTES,
    maxExpandedBytes: MAX_PACKAGE_BYTES,
    maxEntryBytes: () => MAX_PACKAGE_BYTES,
  });
  // Publish only after a complete, checked transfer. A failed download never
  // leaves a tarball in the directory consumed by the upload/publication step.
  let existing;
  try {
    existing = lstatSync(outputDir);
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      throw error;
    }
  }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error("Restored ClawHub output must be a regular directory.");
    }
    verifyRestoredPackage(outputDir, entry, artifactName);
    return {
      packageName: entry.packageName,
      tarballSha256: entry.tarballSha256,
      inventoryDigest: entry.inventoryDigest,
    };
  }
  const staging = mkdtempSync(`${outputDir}.download-`);
  try {
    writeFileSync(join(staging, entry.tarballName), files.get(entry.tarballName), {
      flag: "wx",
      mode: 0o600,
    });
    verifyRestoredPackage(staging, entry, artifactName);
    renameSync(staging, outputDir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return {
    packageName: entry.packageName,
    tarballSha256: entry.tarballSha256,
    inventoryDigest: entry.inventoryDigest,
  };
}
export function createPreparedClawHubManifest({
  candidateSha,
  producer,
  selectionMode,
  matrix,
  directory,
  artifacts,
  workflowRun,
  workflowJobs,
}) {
  validateProducer(producer);
  matches(selectionMode, /^(selected|all-publishable)$/u, "Prepared ClawHub selection mode");
  const packages = orderedSelection(matrix).map((selected) => {
    const entry = matrix.find((item) => item.packageName === selected.packageName);
    if (entry.artifactName !== preparedPackageArtifactName(entry, producer)) {
      throw new Error(
        "Prepared ClawHub package artifact does not bind its exact producer attempt; rerun all preparation jobs.",
      );
    }
    const artifactMatches = artifacts.filter((artifact) => artifact.name === entry.artifactName);
    if (artifactMatches.length !== 1) {
      throw new Error(`Prepared ClawHub artifact is missing or ambiguous: ${entry.artifactName}.`);
    }
    const artifact = artifactMatches[0];
    // Failed-job reruns retain the run ID/SHA and may reuse older matrix outputs.
    // Both the artifact name and its successful pack job must bind this attempt.
    const expected = {
      ...producer,
      artifactId: artifact.id,
      artifactName: artifact.name,
      artifactDigest: artifact.digest,
      artifactSizeBytes: artifact.size_in_bytes,
      runStatePolicy: "same-run-producer-success",
      consumerRunAttempt: producer.runAttempt,
      producerJobName: `Pack ClawHub package (${entry.packageName})`,
    };
    validateActionsArtifactBinding({
      expected,
      artifactMetadata: artifact,
      workflowRun: workflowRunForProducer(workflowRun, producer),
    });
    validateActionsArtifactProducerJob({ expected, workflowJobs });
    const artifactDir = join(directory, entry.artifactName);
    const transaction = readPackedClawHubTransaction({
      artifactDir,
      artifactName: entry.artifactName,
      packageName: entry.packageName,
      version: entry.version,
    });
    return validatePackage({
      ...selected,
      artifactId: artifact.id,
      artifactName: artifact.name,
      artifactDigest: artifact.digest,
      artifactSizeBytes: artifact.size_in_bytes,
      tarballName: readdirSync(artifactDir)[0],
      tarballSha256: transaction.artifactSha256,
      tarballSizeBytes: transaction.artifactSize,
      inventoryDigest: transaction.inventoryDigest,
    });
  });
  return {
    schemaVersion: 1,
    kind: "openclaw-clawhub-prepared",
    candidateSha: matches(candidateSha, SHA, "Prepared ClawHub candidate SHA"),
    producer,
    selectionMode,
    packages,
  };
}
function readJson(file) {
  return JSON.parse(
    readBoundedRegularFile(file, { label: file, maxBytes: MAX_MANIFEST_BYTES }).toString("utf8"),
  );
}
function listRunInventory(path, field) {
  const entries = [];
  for (let page = 1; page <= 20; page++) {
    const result = api(`${path}?per_page=100&page=${page}`);
    if (
      !Array.isArray(result[field]) ||
      !Number.isSafeInteger(result.total_count) ||
      result.total_count < 0 ||
      result.total_count > 2000
    ) {
      throw new Error(`Prepared ClawHub ${field} inventory is invalid.`);
    }
    entries.push(...result[field]);
    if (entries.length === result.total_count) {
      return { total_count: result.total_count, [field]: entries };
    }
    if (result[field].length === 0 || entries.length > result.total_count) {
      break;
    }
  }
  throw new Error(`Prepared ClawHub ${field} inventory is incomplete.`);
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      ["descriptor", "matrix", "directory", "output", "package"].map((key) => [
        key,
        { type: "string" },
      ]),
    ),
  });
  const env = process.env;
  let result;
  if (positionals[0] === "seal") {
    const producer = validateProducer({
      repository: env.GITHUB_REPOSITORY,
      runId: Number(env.GITHUB_RUN_ID),
      runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
      workflowPath: CLAWHUB_CHILD_WORKFLOW,
      workflowEvent: env.GITHUB_EVENT_NAME,
      workflowHeadBranch: env.GITHUB_REF_NAME,
      workflowSha: env.GITHUB_WORKFLOW_SHA,
    });
    if (
      env.DRY_RUN !== "true" ||
      env.GITHUB_WORKFLOW_REF !==
        `${REPOSITORY}/${CLAWHUB_CHILD_WORKFLOW}@${producerFullRef(producer)}`
    ) {
      throw new Error("Prepared ClawHub artifacts must be sealed by the validation-only workflow.");
    }
    result = createPreparedClawHubManifest({
      candidateSha: env.TARGET_SHA,
      producer,
      selectionMode: env.PUBLISH_SCOPE,
      matrix: readJson(values.matrix),
      directory: values.directory,
      artifacts: listRunInventory(`actions/runs/${producer.runId}/artifacts`, "artifacts")
        .artifacts,
      workflowRun: api(`actions/runs/${producer.runId}/attempts/${producer.runAttempt}`),
      workflowJobs: listRunInventory(
        `actions/runs/${producer.runId}/attempts/${producer.runAttempt}/jobs`,
        "jobs",
      ),
    });
    writeFileSync(
      env.GITHUB_OUTPUT,
      `artifact_name=${preparedClawHubArtifactName(env.TARGET_SHA, producer)}\n`,
      { flag: "a" },
    );
  } else if (positionals[0] === "resolve") {
    result = await resolvePreparedClawHubMatrix({
      descriptor: readJson(values.descriptor),
      candidateSha: env.TARGET_SHA,
      toolingSha: env.GITHUB_WORKFLOW_SHA,
      selectionMode: env.PUBLISH_SCOPE,
      plugins: env.RELEASE_PLUGINS,
      token: env.GH_TOKEN,
    });
  } else if (positionals[0] === "restore") {
    const selected = readJson(values.package);
    same(
      selectionEntry(selected),
      selectionEntry(selected.prepared),
      "Prepared ClawHub package selection",
    );
    result = await restorePreparedClawHubPackage({
      descriptor: readJson(values.descriptor),
      entry: selected.prepared,
      artifactName: selected.artifactName,
      toolingSha: env.GITHUB_WORKFLOW_SHA,
      outputDir: values.directory,
      token: env.GH_TOKEN,
    });
  } else {
    throw new Error("Expected seal, resolve, or restore.");
  }
  if (values.output) {
    mkdirSync(dirname(values.output), { recursive: true });
    writeFileSync(values.output, `${JSON.stringify(result)}\n`, { flag: "wx" });
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[clawhub-prepared-artifact] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
