#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CLAWHUB_PUBLICATION_TAR_LIMITS,
  inspectPackageTarballBytes,
  validatePluginPackageManifest,
} from "../plugin-publication-artifact.mjs";
import {
  describeActionsArtifactFiles,
  readBoundedRegularFile,
  readPublicationArtifactArchive,
} from "./actions-artifact-archive.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const PACKAGE_NAME_PATTERN = /^@openclaw\/[a-z0-9][a-z0-9._-]*$/u;
const PACKAGE_DIR_PATTERN = /^extensions\/[a-z0-9][a-z0-9._-]*$/u;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const PROTECTED_WORKFLOW_TAG_PATTERN =
  /^refs\/tags\/(release-publish\/([a-f0-9]{12})-[1-9][0-9]*)$/u;
const VERSION_PATTERN =
  /^[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:-(?:alpha|beta)\.[1-9][0-9]*|-[1-9][0-9]*)?$/u;
const TOOLCHAIN_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const MAX_BOOTSTRAP_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_BOOTSTRAP_ARCHIVE_FILES = 128;
const MAX_BOOTSTRAP_PACKAGES = MAX_BOOTSTRAP_ARCHIVE_FILES - 1;
const MAX_BOOTSTRAP_MANIFEST_BYTES = 2 * 1024 * 1024;
// The compressed and total-payload limits match ClawHub's ClawPack contract.
// The expanded TAR and entry-count ceilings bound this credential-job parser.
const MAX_CLAWPACK_BYTES = CLAWHUB_PUBLICATION_TAR_LIMITS.maxArchiveBytes;

function fail(message) {
  throw new Error(message);
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} is required.`);
  }
  return value.trim();
}

function requirePattern(value, pattern, label) {
  const result = requireString(value, label);
  if (!pattern.test(result)) {
    fail(`${label} is invalid.`);
  }
  return result;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail(`${label} must be a boolean.`);
  }
  return value;
}

function parsePlugins(value) {
  const plugins = requireString(value, "plugins")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unique = [...new Set(plugins)].toSorted(compareCodeUnits);
  if (unique.length !== plugins.length) {
    fail("plugins must not contain duplicates.");
  }
  for (const plugin of unique) {
    requirePattern(plugin, PACKAGE_NAME_PATTERN, `plugin ${plugin}`);
  }
  return unique;
}

function packageSlug(packageName) {
  return packageName.slice("@openclaw/".length);
}

function normalizePlanEntry(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`matrix[${index}] must be an object.`);
  }
  const packageName = requirePattern(
    value.packageName,
    PACKAGE_NAME_PATTERN,
    `matrix[${index}].packageName`,
  );
  const packageDir = requirePattern(
    value.packageDir,
    PACKAGE_DIR_PATTERN,
    `matrix[${index}].packageDir`,
  );
  const publishTag = requirePattern(value.publishTag, TAG_PATTERN, `matrix[${index}].publishTag`);
  const version = requirePattern(value.version, VERSION_PATTERN, `matrix[${index}].version`);
  const bootstrapMode = requireString(value.bootstrapMode, `matrix[${index}].bootstrapMode`);
  if (bootstrapMode !== "publish" && bootstrapMode !== "configure-only") {
    fail(`matrix[${index}].bootstrapMode is invalid.`);
  }
  const requiresManualOverride = requireBoolean(
    value.requiresManualOverride,
    `matrix[${index}].requiresManualOverride`,
  );
  if (bootstrapMode === "configure-only" && !requiresManualOverride) {
    fail(`matrix[${index}] configure-only entries must require the manual override.`);
  }
  return {
    packageName,
    version,
    packageDir,
    publishTag,
    bootstrapMode,
    requiresManualOverride,
  };
}

function hashBytes(bytes) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

async function hashFile(path) {
  return hashBytes(
    readBoundedRegularFile(path, {
      label: "Packed ClawHub artifact",
      maxBytes: MAX_CLAWPACK_BYTES,
    }),
  );
}

export async function verifyClawHubPackedArtifactIdentity(options) {
  const artifactPath = resolve(requireString(options.artifactPath, "artifactPath"));
  const expectedSha256 = requirePattern(options.expectedSha256, SHA256_PATTERN, "expectedSha256");
  const expectedSize = requirePattern(
    options.expectedSize,
    POSITIVE_INTEGER_PATTERN,
    "expectedSize",
  );
  const expectedName = requirePattern(options.expectedName, PACKAGE_NAME_PATTERN, "expectedName");
  const expectedVersion = requireString(options.expectedVersion, "expectedVersion");
  const expectedDir = requirePattern(options.expectedDir, PACKAGE_DIR_PATTERN, "expectedDir");

  const artifactStat = await lstat(artifactPath);
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
    fail("Packed ClawHub artifact must be a regular file.");
  }
  if (artifactStat.size > MAX_CLAWPACK_BYTES) {
    fail(`Packed ClawHub artifact exceeds ${MAX_CLAWPACK_BYTES} bytes.`);
  }
  if (String(artifactStat.size) !== expectedSize) {
    fail("Packed ClawHub artifact hash or size mismatch.");
  }
  const bytes = readBoundedRegularFile(artifactPath, {
    label: "Packed ClawHub artifact",
    maxBytes: MAX_CLAWPACK_BYTES,
  });
  const identity = hashBytes(bytes);
  if (identity.sha256 !== expectedSha256 || String(identity.size) !== expectedSize) {
    fail("Packed ClawHub artifact hash or size mismatch.");
  }

  const inspection = inspectPackageTarballBytes(bytes, CLAWHUB_PUBLICATION_TAR_LIMITS);
  validatePluginPackageManifest(
    {
      packageDir: expectedDir,
      packageName: expectedName,
      route: "clawhub-token-bootstrap",
      version: expectedVersion,
    },
    inspection.packageManifest,
  );
  const packageName = inspection.packageManifest.name;
  const packageVersion = inspection.packageManifest.version;
  return {
    ...identity,
    inventory: inspection.inventory,
    packageJsonSha256: inspection.packageManifestSha256,
    packageName,
    packageVersion,
    pluginManifestSha256: inspection.pluginManifestSha256,
  };
}

async function listFiles(root) {
  const result = [];
  let visitedEntries = 0;
  let totalPathBytes = 0;
  async function visit(directory, depth) {
    if (depth > 4) {
      fail("Artifact inventory exceeds the supported directory depth.");
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      visitedEntries += 1;
      if (visitedEntries > MAX_BOOTSTRAP_ARCHIVE_FILES * 4) {
        fail("Artifact inventory contains too many filesystem entries.");
      }
      if (entry.isSymbolicLink()) {
        fail(`Artifact inventory contains a symlink: ${relative(root, path)}`);
      }
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (entry.isFile()) {
        const artifactPath = relative(root, path).split(sep).join("/");
        totalPathBytes += Buffer.byteLength(artifactPath, "utf8");
        if (
          result.length >= MAX_BOOTSTRAP_ARCHIVE_FILES ||
          totalPathBytes > MAX_BOOTSTRAP_MANIFEST_BYTES
        ) {
          fail("Artifact inventory exceeds its file or path-byte limit.");
        }
        result.push(artifactPath);
      } else {
        fail(`Artifact inventory contains a non-regular entry: ${relative(root, path)}`);
      }
    }
  }
  await visit(root, 0);
  return result.toSorted(compareCodeUnits);
}

function readPositiveInteger(value, label) {
  const raw = requirePattern(value, POSITIVE_INTEGER_PATTERN, label);
  const result = Number(raw);
  if (!Number.isSafeInteger(result)) {
    fail(`${label} is outside the supported range.`);
  }
  return result;
}

function requireExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const actual = Object.keys(value).toSorted(compareCodeUnits);
  if (JSON.stringify(actual) !== JSON.stringify([...expected].toSorted(compareCodeUnits))) {
    fail(`${label} keys are invalid: ${actual.join(",")}.`);
  }
}

function normalizeBootstrapManifestEntry(value, index) {
  requireExactKeys(
    value,
    [
      "artifactPath",
      "bootstrapMode",
      "packageDir",
      "packageName",
      "publishTag",
      "requiresManualOverride",
      "sha256",
      "size",
      "version",
    ],
    `manifest.entries[${index}]`,
  );
  const entry = normalizePlanEntry(value, index);
  const expectedPrefix = `packages/${packageSlug(entry.packageName)}/`;
  const artifactPath = requireString(value.artifactPath, `manifest.entries[${index}].artifactPath`);
  if (
    artifactPath !== `${expectedPrefix}${basename(artifactPath)}` ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(basename(artifactPath))
  ) {
    fail(`Bootstrap Actions artifact path is invalid: ${artifactPath}`);
  }
  const sha256 = requirePattern(value.sha256, SHA256_PATTERN, `manifest.entries[${index}].sha256`);
  if (!Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_CLAWPACK_BYTES) {
    fail(`manifest.entries[${index}].size is invalid.`);
  }
  return { ...entry, artifactPath, sha256, size: value.size };
}

export function parseClawHubBootstrapManifestBytes(inputBytes) {
  const manifestBytes = Buffer.isBuffer(inputBytes) ? inputBytes : Buffer.from(inputBytes);
  if (manifestBytes.byteLength === 0 || manifestBytes.byteLength > MAX_BOOTSTRAP_MANIFEST_BYTES) {
    fail(`ClawHub bootstrap manifest must be 1-${MAX_BOOTSTRAP_MANIFEST_BYTES} bytes.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    fail("ClawHub bootstrap manifest is not valid UTF-8 JSON.");
  }
  requireExactKeys(
    manifest,
    [
      "artifactName",
      "clawhubToolchainIntegrity",
      "clawhubToolchainSha256",
      "clawhubToolchainVersion",
      "entries",
      "repository",
      "requestedPlugins",
      "runAttempt",
      "runId",
      "schemaVersion",
      "targetSha",
      "workflowSha",
    ],
    "ClawHub bootstrap manifest",
  );
  if (manifest.schemaVersion !== 1) {
    fail(`Unsupported ClawHub bootstrap manifest schema: ${String(manifest.schemaVersion)}.`);
  }
  const repository = requirePattern(manifest.repository, REPOSITORY_PATTERN, "manifest.repository");
  const targetSha = requirePattern(manifest.targetSha, COMMIT_PATTERN, "manifest.targetSha");
  const workflowSha = requirePattern(manifest.workflowSha, COMMIT_PATTERN, "manifest.workflowSha");
  const runId = requirePattern(manifest.runId, POSITIVE_INTEGER_PATTERN, "manifest.runId");
  const runAttempt = requirePattern(
    manifest.runAttempt,
    POSITIVE_INTEGER_PATTERN,
    "manifest.runAttempt",
  );
  const artifactName = requireString(manifest.artifactName, "manifest.artifactName");
  const clawhubToolchainSha256 = requirePattern(
    manifest.clawhubToolchainSha256,
    SHA256_PATTERN,
    "manifest.clawhubToolchainSha256",
  );
  const clawhubToolchainVersion = requirePattern(
    manifest.clawhubToolchainVersion,
    TOOLCHAIN_VERSION_PATTERN,
    "manifest.clawhubToolchainVersion",
  );
  const clawhubToolchainIntegrity = requirePattern(
    manifest.clawhubToolchainIntegrity,
    SHA512_INTEGRITY_PATTERN,
    "manifest.clawhubToolchainIntegrity",
  );
  if (
    !Array.isArray(manifest.requestedPlugins) ||
    manifest.requestedPlugins.length === 0 ||
    manifest.requestedPlugins.length > MAX_BOOTSTRAP_PACKAGES ||
    manifest.requestedPlugins.some((entry) => typeof entry !== "string")
  ) {
    fail("ClawHub bootstrap manifest requestedPlugins is invalid.");
  }
  const requestedPlugins = parsePlugins(manifest.requestedPlugins.join(","));
  if (JSON.stringify(requestedPlugins) !== JSON.stringify(manifest.requestedPlugins)) {
    fail("ClawHub bootstrap manifest requestedPlugins is not canonical.");
  }
  if (
    !Array.isArray(manifest.entries) ||
    manifest.entries.length === 0 ||
    manifest.entries.length > MAX_BOOTSTRAP_PACKAGES
  ) {
    fail("ClawHub bootstrap manifest entries are invalid.");
  }
  const entries = manifest.entries.map(normalizeBootstrapManifestEntry);
  if (new Set(entries.map((entry) => entry.packageName)).size !== entries.length) {
    fail("ClawHub bootstrap manifest contains duplicate package names.");
  }
  assertExactPackageSet(entries, requestedPlugins);
  const entryNames = entries.map((entry) => entry.packageName);
  if (JSON.stringify(entryNames) !== JSON.stringify(entryNames.toSorted(compareCodeUnits))) {
    fail("ClawHub bootstrap manifest entries are not canonical.");
  }
  return {
    artifactName,
    clawhubToolchainIntegrity,
    clawhubToolchainSha256,
    clawhubToolchainVersion,
    entries,
    repository,
    requestedPlugins,
    runAttempt,
    runId,
    schemaVersion: 1,
    targetSha,
    workflowSha,
  };
}

export function readClawHubBootstrapManifest(path) {
  return parseClawHubBootstrapManifestBytes(
    readBoundedRegularFile(path, {
      label: "ClawHub bootstrap manifest",
      maxBytes: MAX_BOOTSTRAP_MANIFEST_BYTES,
    }),
  );
}

function validateBootstrapArchiveInventory(files, expectedBinding) {
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes) {
    fail("Bootstrap Actions artifact must contain manifest.json.");
  }
  const manifest = parseClawHubBootstrapManifestBytes(manifestBytes);
  for (const [key, expected] of Object.entries(expectedBinding)) {
    if (manifest[key] !== String(expected)) {
      fail(`Bootstrap Actions artifact manifest ${key} mismatch.`);
    }
  }
  const { entries, requestedPlugins } = manifest;

  const expected = new Set(["manifest.json"]);
  for (const entry of entries) {
    const artifactPath = entry.artifactPath;
    if (expected.has(artifactPath)) {
      fail(`Bootstrap Actions artifact path is duplicated: ${artifactPath}`);
    }
    const bytes = files.get(artifactPath);
    if (!bytes || bytes.byteLength !== entry.size || hashBytes(bytes).sha256 !== entry.sha256) {
      fail(`Bootstrap Actions artifact bytes do not match manifest: ${artifactPath}`);
    }
    expected.add(artifactPath);
  }
  const actual = new Set(files.keys());
  if (actual.size !== expected.size || [...actual].some((path) => !expected.has(path))) {
    fail(
      `Bootstrap Actions artifact inventory mismatch: expected ${[...expected].toSorted(compareCodeUnits).join(",")}, found ${[...actual].toSorted(compareCodeUnits).join(",")}.`,
    );
  }
  return { entries, manifest, requestedPlugins };
}

export async function downloadClawHubBootstrapArtifact(options) {
  const artifactId = readPositiveInteger(options.artifactId, "artifactId");
  const artifactSizeBytes = readPositiveInteger(options.artifactSize, "artifactSize");
  const runId = readPositiveInteger(options.runId, "runId");
  const runAttempt = readPositiveInteger(options.runAttempt, "runAttempt");
  const consumerRunAttempt = readPositiveInteger(options.consumerRunAttempt, "consumerRunAttempt");
  const producerJobName = requireString(options.producerJobName, "producerJobName");
  const targetSha = requirePattern(options.targetSha, COMMIT_PATTERN, "targetSha");
  const workflowSha = requirePattern(options.workflowSha, COMMIT_PATTERN, "workflowSha");
  const workflowHeadBranch = requireString(options.workflowHeadBranch, "workflowHeadBranch");
  const workflowRef = requireString(options.workflowRef, "workflowRef");
  const protectedWorkflowTag = PROTECTED_WORKFLOW_TAG_PATTERN.exec(workflowRef);
  const trustedMain = workflowRef === "refs/heads/main" && workflowHeadBranch === "main";
  const trustedProtectedTag =
    protectedWorkflowTag !== null &&
    workflowHeadBranch === protectedWorkflowTag[1] &&
    protectedWorkflowTag[2] === workflowSha.slice(0, 12);
  if (!trustedMain && !trustedProtectedTag) {
    fail("workflowRef must be main or the SHA-pinned release-publish tag.");
  }
  const artifactDigest = requirePattern(options.artifactDigest, SHA256_PATTERN, "artifactDigest");
  const artifactName = requireString(options.artifactName, "artifactName");
  const repository = requirePattern(options.repository, REPOSITORY_PATTERN, "repository");
  const clawhubToolchainSha256 = requirePattern(
    options.clawhubToolchainSha256,
    SHA256_PATTERN,
    "clawhubToolchainSha256",
  );
  const clawhubToolchainVersion = requirePattern(
    options.clawhubToolchainVersion,
    TOOLCHAIN_VERSION_PATTERN,
    "clawhubToolchainVersion",
  );
  const clawhubToolchainIntegrity = requirePattern(
    options.clawhubToolchainIntegrity,
    SHA512_INTEGRITY_PATTERN,
    "clawhubToolchainIntegrity",
  );
  const expectedName = `clawhub-bootstrap-${targetSha.slice(0, 12)}-${runId}-${runAttempt}`;
  if (artifactName !== expectedName) {
    fail("ClawHub bootstrap artifact name does not bind the target and producer attempt.");
  }
  const outputRoot = resolve(requireString(options.outputRoot, "outputRoot"));
  try {
    await lstat(outputRoot);
    fail("ClawHub bootstrap artifact output directory must not already exist.");
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      throw error;
    }
  }
  const result = await readPublicationArtifactArchive({
    archivePolicy: {
      minEntries: 2,
      maxEntries: MAX_BOOTSTRAP_ARCHIVE_FILES,
      maxArchiveBytes: MAX_BOOTSTRAP_ARCHIVE_BYTES,
      maxExpandedBytes: MAX_BOOTSTRAP_ARCHIVE_BYTES,
      allowPath: (path) =>
        path === "manifest.json" ||
        /^packages\/[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(path),
      maxCompressedEntryBytes: (path) =>
        path === "manifest.json" ? MAX_BOOTSTRAP_MANIFEST_BYTES : MAX_CLAWPACK_BYTES,
      maxEntryBytes: (path) =>
        path === "manifest.json" ? MAX_BOOTSTRAP_MANIFEST_BYTES : MAX_CLAWPACK_BYTES,
    },
    expected: {
      artifactDigest: `sha256:${artifactDigest}`,
      artifactId,
      artifactName,
      artifactSizeBytes,
      consumerRunAttempt,
      producerJobName,
      repository,
      runStatePolicy: "same-run-producer-success",
      runAttempt,
      runId,
      workflowEvent: "workflow_dispatch",
      workflowHeadBranch,
      workflowPath: ".github/workflows/plugin-clawhub-new.yml",
      workflowSha,
    },
    maxArchiveBytes: MAX_BOOTSTRAP_ARCHIVE_BYTES,
    fetchImpl: options.fetchImpl,
    retryAttempts: options.retryAttempts,
    retryDelayMs: options.retryDelayMs,
    token: requireString(options.token, "token"),
  });
  const validated = validateBootstrapArchiveInventory(result.files, {
    artifactName,
    clawhubToolchainIntegrity,
    clawhubToolchainSha256,
    clawhubToolchainVersion,
    repository,
    runAttempt,
    runId,
    targetSha,
    workflowSha,
  });
  await mkdir(dirname(outputRoot), { mode: 0o700, recursive: true });
  try {
    await mkdir(outputRoot, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      fail("ClawHub bootstrap artifact output directory must not already exist.");
    }
    throw error;
  }
  const outputRootStat = await lstat(outputRoot);
  if (!outputRootStat.isDirectory() || outputRootStat.isSymbolicLink()) {
    fail("ClawHub bootstrap artifact output directory must be newly created.");
  }
  for (const [path, bytes] of result.files) {
    const destination = join(outputRoot, path);
    await mkdir(dirname(destination), { mode: 0o700, recursive: true });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
  return {
    artifactDigest,
    artifactId,
    artifactName,
    artifactSizeBytes,
    clawhubToolchainIntegrity,
    clawhubToolchainSha256,
    clawhubToolchainVersion,
    inventory: describeActionsArtifactFiles(result.files),
    packages: validated.entries,
    runAttempt,
    runId,
  };
}

async function resolveRegularArtifactFile(root, artifactPath) {
  if (
    typeof artifactPath !== "string" ||
    artifactPath.startsWith("/") ||
    artifactPath.includes("\\") ||
    artifactPath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`Unsafe artifact path: ${String(artifactPath)}`);
  }
  const rootReal = await realpath(root);
  const candidate = resolve(root, artifactPath);
  const candidateReal = await realpath(candidate);
  if (candidateReal !== rootReal && !candidateReal.startsWith(`${rootReal}${sep}`)) {
    fail(`Artifact path escapes the artifact root: ${artifactPath}`);
  }
  const fileStat = await lstat(candidate);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    fail(`Artifact path is not a regular file: ${artifactPath}`);
  }
  return candidate;
}

function assertExactPackageSet(entries, expectedPlugins) {
  const actual = entries.map((entry) => entry.packageName).toSorted(compareCodeUnits);
  if (JSON.stringify(actual) !== JSON.stringify(expectedPlugins)) {
    fail(
      `Artifact package set does not match requested plugins: expected ${expectedPlugins.join(",")}, found ${actual.join(",")}.`,
    );
  }
}

export async function createClawHubBootstrapArtifactManifest(options) {
  const artifactRoot = resolve(options.artifactRoot);
  const matrix = JSON.parse(
    readBoundedRegularFile(options.matrixPath, {
      label: "ClawHub bootstrap matrix",
      maxBytes: MAX_BOOTSTRAP_MANIFEST_BYTES,
    }).toString("utf8"),
  );
  if (!Array.isArray(matrix) || matrix.length === 0 || matrix.length > MAX_BOOTSTRAP_PACKAGES) {
    fail("matrix must be a non-empty array.");
  }
  const entries = matrix.map(normalizePlanEntry);
  const expectedPlugins = parsePlugins(options.plugins);
  if (new Set(entries.map((entry) => entry.packageName)).size !== entries.length) {
    fail("matrix must not contain duplicate package names.");
  }
  assertExactPackageSet(entries, expectedPlugins);

  const manifestEntries = [];
  for (const entry of entries.toSorted((a, b) => compareCodeUnits(a.packageName, b.packageName))) {
    const packageDirectory = join(artifactRoot, "packages", packageSlug(entry.packageName));
    const files = (await readdir(packageDirectory)).filter((name) => name.endsWith(".tgz"));
    if (files.length !== 1) {
      fail(`${entry.packageName} must have exactly one packed .tgz artifact.`);
    }
    const artifactPath = `packages/${packageSlug(entry.packageName)}/${files[0]}`;
    const filePath = await resolveRegularArtifactFile(artifactRoot, artifactPath);
    const identity = await hashFile(filePath);
    manifestEntries.push({ ...entry, artifactPath, ...identity });
  }

  const manifest = {
    schemaVersion: 1,
    repository: requirePattern(options.repository, REPOSITORY_PATTERN, "repository"),
    targetSha: requirePattern(options.targetSha, COMMIT_PATTERN, "targetSha"),
    workflowSha: requirePattern(options.workflowSha, COMMIT_PATTERN, "workflowSha"),
    runId: requirePattern(options.runId, POSITIVE_INTEGER_PATTERN, "runId"),
    runAttempt: requirePattern(options.runAttempt, POSITIVE_INTEGER_PATTERN, "runAttempt"),
    artifactName: requireString(options.artifactName, "artifactName"),
    clawhubToolchainIntegrity: requirePattern(
      options.clawhubToolchainIntegrity,
      SHA512_INTEGRITY_PATTERN,
      "clawhubToolchainIntegrity",
    ),
    clawhubToolchainSha256: requirePattern(
      options.clawhubToolchainSha256,
      SHA256_PATTERN,
      "clawhubToolchainSha256",
    ),
    clawhubToolchainVersion: requirePattern(
      options.clawhubToolchainVersion,
      TOOLCHAIN_VERSION_PATTERN,
      "clawhubToolchainVersion",
    ),
    requestedPlugins: expectedPlugins,
    entries: manifestEntries,
  };
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function verifyClawHubBootstrapArtifactManifest(options) {
  const artifactRoot = resolve(options.artifactRoot);
  const manifest = readClawHubBootstrapManifest(options.manifestPath);
  const expected = {
    repository: requirePattern(options.repository, REPOSITORY_PATTERN, "repository"),
    targetSha: requirePattern(options.targetSha, COMMIT_PATTERN, "targetSha"),
    workflowSha: requirePattern(options.workflowSha, COMMIT_PATTERN, "workflowSha"),
    runId: requirePattern(options.runId, POSITIVE_INTEGER_PATTERN, "runId"),
    runAttempt: requirePattern(options.runAttempt, POSITIVE_INTEGER_PATTERN, "runAttempt"),
    artifactName: requireString(options.artifactName, "artifactName"),
    clawhubToolchainIntegrity: requirePattern(
      options.clawhubToolchainIntegrity,
      SHA512_INTEGRITY_PATTERN,
      "clawhubToolchainIntegrity",
    ),
    clawhubToolchainSha256: requirePattern(
      options.clawhubToolchainSha256,
      SHA256_PATTERN,
      "clawhubToolchainSha256",
    ),
    clawhubToolchainVersion: requirePattern(
      options.clawhubToolchainVersion,
      TOOLCHAIN_VERSION_PATTERN,
      "clawhubToolchainVersion",
    ),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key] !== value) {
      fail(`Bootstrap artifact manifest ${key} mismatch.`);
    }
  }

  const expectedPlugins = parsePlugins(options.plugins);
  if (!Array.isArray(manifest.requestedPlugins)) {
    fail("Bootstrap artifact manifest requestedPlugins must be an array.");
  }
  if (JSON.stringify(manifest.requestedPlugins) !== JSON.stringify(expectedPlugins)) {
    fail("Bootstrap artifact manifest requestedPlugins mismatch.");
  }
  if (
    !Array.isArray(manifest.entries) ||
    manifest.entries.length === 0 ||
    manifest.entries.length > MAX_BOOTSTRAP_PACKAGES
  ) {
    fail("Bootstrap artifact manifest entries must be a non-empty array.");
  }

  const entries = [];
  const allowedFiles = new Set([relative(artifactRoot, options.manifestPath).split(sep).join("/")]);
  for (const [index, rawEntry] of manifest.entries.entries()) {
    const entry = normalizeBootstrapManifestEntry(rawEntry, index);
    const { artifactPath } = entry;
    const filePath = await resolveRegularArtifactFile(artifactRoot, artifactPath);
    const identity = await hashFile(filePath);
    if (identity.sha256 !== entry.sha256 || identity.size !== entry.size) {
      fail(`${entry.packageName} packed artifact hash or size mismatch.`);
    }
    allowedFiles.add(artifactPath);
    entries.push({ ...entry, artifactPath, ...identity });
  }
  if (new Set(entries.map((entry) => entry.packageName)).size !== entries.length) {
    fail("Bootstrap artifact manifest must not contain duplicate package names.");
  }
  assertExactPackageSet(entries, expectedPlugins);

  const inventory = await listFiles(artifactRoot);
  const expectedInventory = [...allowedFiles].toSorted(compareCodeUnits);
  if (JSON.stringify(inventory) !== JSON.stringify(expectedInventory)) {
    fail(
      `Bootstrap artifact inventory mismatch: expected ${expectedInventory.join(",")}, found ${inventory.join(",")}.`,
    );
  }
  return { ...manifest, entries };
}

function parseArgs(argv) {
  const values = [...argv];
  const command = values.shift();
  const result = { command };
  while (values.length > 0) {
    const key = values.shift();
    const value = values.shift();
    if (!key?.startsWith("--") || value === undefined) {
      fail(`Invalid argument: ${String(key)}`);
    }
    result[key.slice(2).replaceAll("-", "_")] = value;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "download") {
    const result = await downloadClawHubBootstrapArtifact({
      artifactDigest: args.artifact_digest,
      artifactId: args.artifact_id,
      artifactName: args.artifact_name,
      artifactSize: args.artifact_size,
      consumerRunAttempt: args.consumer_run_attempt,
      clawhubToolchainIntegrity: args.clawhub_toolchain_integrity,
      clawhubToolchainSha256: args.clawhub_toolchain_sha256,
      clawhubToolchainVersion: args.clawhub_toolchain_version,
      outputRoot: args.output_root,
      producerJobName: args.producer_job_name,
      repository: args.repository,
      runAttempt: args.run_attempt,
      runId: args.run_id,
      targetSha: args.target_sha,
      token: process.env.GH_TOKEN,
      workflowSha: args.workflow_sha,
      workflowHeadBranch: args.workflow_head_branch,
      workflowRef: args.workflow_ref,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (args.command === "verify-packed") {
    const identity = await verifyClawHubPackedArtifactIdentity({
      artifactPath: args.path,
      expectedDir: args.expected_dir,
      expectedSha256: args.expected_sha256,
      expectedSize: args.expected_size,
      expectedName: args.expected_name,
      expectedVersion: args.expected_version,
    });
    process.stdout.write(`${JSON.stringify(identity)}\n`);
    return;
  }
  const common = {
    artifactRoot: args.artifact_root,
    artifactName: args.artifact_name,
    clawhubToolchainIntegrity: args.clawhub_toolchain_integrity,
    clawhubToolchainSha256: args.clawhub_toolchain_sha256,
    clawhubToolchainVersion: args.clawhub_toolchain_version,
    repository: args.repository,
    targetSha: args.target_sha,
    workflowSha: args.workflow_sha,
    runId: args.run_id,
    runAttempt: args.run_attempt,
    plugins: args.plugins,
  };
  if (args.command === "create") {
    await createClawHubBootstrapArtifactManifest({
      ...common,
      matrixPath: args.matrix,
      outputPath: args.output,
    });
    return;
  }
  if (args.command === "verify") {
    const manifest = await verifyClawHubBootstrapArtifactManifest({
      ...common,
      manifestPath: args.manifest,
    });
    if (args.output) {
      await mkdir(dirname(args.output), { recursive: true });
      await writeFile(args.output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    } else {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    }
    return;
  }
  fail("Usage: clawhub-bootstrap-artifact.mjs <create|download|verify|verify-packed> [options]");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
