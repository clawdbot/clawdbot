#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { readPublicationArtifactArchive, sha256Digest } from "./lib/actions-artifact-archive.mjs";
import { fetchNpmRegistryPackumentWithRetry } from "./lib/npm-publish-plan.mjs";

const MANIFEST_FILENAME = "npm-placeholder-manifest.json";
const MANIFEST_SCHEMA = "openclaw.npm-placeholder-publication/v1";
const PACKAGE_VERSION = "0.0.0";
const PUBLISH_TAG = "placeholder";
const WORKFLOW_PATH = ".github/workflows/npm-placeholder-bootstrap.yml";
const PACKAGE_NAME_RE = /^@openclaw\/[a-z0-9][a-z0-9._-]*$/u;
const SHA_RE = /^[0-9a-f]{40}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** @typedef {typeof fetch} PlaceholderFetch */
/**
 * @typedef {object} CreatePlaceholderPublicationParams
 * @property {PlaceholderFetch} [fetchImpl]
 * @property {string} outputDir
 * @property {string} packages
 * @property {string} repoRoot
 * @property {string} targetSha
 * @property {string} workflowSha
 */
/**
 * @typedef {object} PublishPlaceholdersParams
 * @property {string} artifactDir
 * @property {PlaceholderFetch} [fetchImpl]
 * @property {string} npmToken
 * @property {(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => void} [npmRunner]
 * @property {number} [registryAttempts]
 * @property {(delayMs: number) => Promise<void>} [sleep]
 * @property {string} targetSha
 * @property {string} [tempRoot]
 * @property {string} workflowSha
 */

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertTrimmedString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function assertCommitSha(value, label) {
  const sha = assertTrimmedString(value, label);
  if (!SHA_RE.test(sha)) {
    throw new Error(`${label} must be a full lowercase commit SHA.`);
  }
  return sha;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function npmIntegrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function npmShasum(bytes) {
  return createHash("sha1").update(bytes).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function placeholderPackageJson(packageName) {
  return {
    name: packageName,
    version: PACKAGE_VERSION,
    description: "Reserved package name for an official OpenClaw plugin.",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/openclaw/openclaw.git",
    },
    publishConfig: {
      access: "public",
      tag: PUBLISH_TAG,
    },
  };
}

function placeholderReadme(packageName) {
  return `# ${packageName}\n\nReserved placeholder for the official OpenClaw plugin package. Use a published release version instead.\n`;
}

function writeTarString(header, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new Error(`Tar header value exceeds ${length} bytes.`);
  }
  bytes.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  writeTarString(header, offset, length, `${encoded}\0`);
}

function tarEntry(path, content) {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, path);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, content.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar\0");
  writeTarString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

export function createPlaceholderTarball(packageName) {
  if (!PACKAGE_NAME_RE.test(packageName)) {
    throw new Error(`Invalid OpenClaw package name: ${packageName}`);
  }
  const packageJson = Buffer.from(canonicalJson(placeholderPackageJson(packageName)), "utf8");
  const readme = Buffer.from(placeholderReadme(packageName), "utf8");
  const tar = Buffer.concat([
    tarEntry("package/package.json", packageJson),
    tarEntry("package/README.md", readme),
    Buffer.alloc(1024),
  ]);
  return gzipSync(tar, { level: 9, mtime: 0 });
}

export function parseSelectedPackages(input) {
  const raw = assertTrimmedString(input, "package selection");
  const packages = raw.split(",").map((value) => value.trim());
  if (packages.some((value) => value.length === 0)) {
    throw new Error("Package selection must not contain empty entries.");
  }
  for (const packageName of packages) {
    if (!PACKAGE_NAME_RE.test(packageName)) {
      throw new Error(`Invalid OpenClaw package name: ${packageName}`);
    }
  }
  if (new Set(packages).size !== packages.length) {
    throw new Error("Package selection must not contain duplicates.");
  }
  return packages;
}

function readJsonRegularFile(path, label) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_FILE_BYTES) {
    throw new Error(`${label} must be a bounded regular file.`);
  }
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is invalid JSON: ${detail}`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain an object.`);
  }
  return value;
}

export function resolveSelectedPackageSources(repoRoot, packageNames) {
  const extensionsDir = resolve(repoRoot, "extensions");
  const officialPackageNames = new Set();
  for (const catalogName of ["plugin", "provider", "channel"]) {
    const catalogPath = resolve(
      repoRoot,
      "scripts",
      "lib",
      `official-external-${catalogName}-catalog.json`,
    );
    const catalog = readJsonRegularFile(catalogPath, `Official external ${catalogName} catalog`);
    if (!Array.isArray(catalog.entries)) {
      throw new Error(`Official external ${catalogName} catalog entries must be an array.`);
    }
    for (const entry of catalog.entries) {
      if (
        entry?.source === "official" &&
        typeof entry.name === "string" &&
        entry.openclaw?.install?.npmSpec === entry.name
      ) {
        officialPackageNames.add(entry.name);
      }
    }
  }
  const candidates = [];
  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const packageDir = `extensions/${entry.name}`;
    const packageJsonPath = resolve(repoRoot, packageDir, "package.json");
    let info;
    try {
      info = lstatSync(packageJsonPath);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`${packageDir}/package.json must be a regular file.`);
    }
    const packageJsonBytes = readFileSync(packageJsonPath);
    const packageJson = readJsonRegularFile(packageJsonPath, `${packageDir}/package.json`);
    candidates.push({ packageDir, packageJson, packageJsonBytes });
  }

  return packageNames.map((packageName) => {
    const matches = candidates.filter((candidate) => candidate.packageJson.name === packageName);
    if (matches.length !== 1) {
      throw new Error(`${packageName} must map uniquely to extensions/*/package.json.`);
    }
    const [match] = matches;
    if (
      match.packageJson.private === true ||
      ["private", "restricted"].includes(match.packageJson.publishConfig?.access) ||
      match.packageJson.openclaw?.install?.npmSpec !== packageName ||
      match.packageJson.openclaw?.build?.bundledDist !== false ||
      match.packageJson.openclaw?.release?.publishToNpm !== true
    ) {
      throw new Error(`${packageName} is not a public release-enabled npm plugin.`);
    }
    if (!officialPackageNames.has(packageName)) {
      throw new Error(`${packageName} is not present in an official external package catalog.`);
    }
    return {
      packageDir: match.packageDir,
      packageName,
      sourcePackageJsonSha256: sha256(match.packageJsonBytes),
    };
  });
}

function normalizeDistTags(value, packageName) {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${packageName}: npm dist-tags must be an object.`);
  }
  const entries = [];
  for (const [tag, version] of Object.entries(value)) {
    if (
      typeof tag !== "string" ||
      tag.length === 0 ||
      typeof version !== "string" ||
      version.length === 0
    ) {
      throw new Error(`${packageName}: npm dist-tags contain an invalid entry.`);
    }
    entries.push([tag, version]);
  }
  return Object.fromEntries(entries.toSorted(([left], [right]) => compareCodeUnits(left, right)));
}

export function classifyRegistryState(params) {
  const { expectedIntegrity, expectedShasum, packageName, registry } = params;
  if (registry.status === 404) {
    return { action: "publish", newPackage: true, nonPlaceholderTags: {} };
  }
  if (registry.status !== 200 || !registry.packument || typeof registry.packument !== "object") {
    throw new Error(`${packageName}: npm registry returned HTTP ${registry.status}.`);
  }
  const distTags = normalizeDistTags(registry.packument["dist-tags"], packageName);
  if (distTags[PUBLISH_TAG] !== undefined && distTags[PUBLISH_TAG] !== PACKAGE_VERSION) {
    throw new Error(
      `${packageName}: placeholder dist-tag points to ${distTags[PUBLISH_TAG]}, expected ${PACKAGE_VERSION}.`,
    );
  }
  const nonPlaceholderTags = Object.fromEntries(
    Object.entries(distTags).filter(([tag]) => tag !== PUBLISH_TAG),
  );
  const publishedDist = registry.packument.versions?.[PACKAGE_VERSION]?.dist;
  if (publishedDist !== undefined) {
    if (
      publishedDist?.integrity !== expectedIntegrity ||
      publishedDist?.shasum !== expectedShasum
    ) {
      throw new Error(`${packageName}@${PACKAGE_VERSION}: npm registry tarball bytes differ.`);
    }
    return {
      action: distTags[PUBLISH_TAG] === PACKAGE_VERSION ? "skip" : "tag",
      newPackage: false,
      nonPlaceholderTags,
    };
  }
  return { action: "publish", newPackage: false, nonPlaceholderTags };
}

async function readRegistry(packageName, fetchImpl = fetch) {
  const result = await fetchNpmRegistryPackumentWithRetry({
    packageName,
    packageUrl: `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
    fetchImpl,
  });
  return { packument: result.packument, status: result.status };
}

async function readStableRegistry(packageName, fetchImpl = fetch) {
  const observations = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    observations.push(await readRegistry(packageName, fetchImpl));
  }
  const serialized = observations.map((observation) => JSON.stringify(observation));
  if (new Set(serialized).size !== 1) {
    throw new Error(`${packageName}: npm registry state changed during placeholder planning.`);
  }
  return observations[0];
}

function assertFreshDirectory(path) {
  try {
    lstatSync(path);
    throw new Error(`Output directory already exists: ${path}`);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** @param {CreatePlaceholderPublicationParams} params */
export async function createPlaceholderPublication(params) {
  const repoRoot = resolve(params.repoRoot);
  const outputDir = resolve(params.outputDir);
  const targetSha = assertCommitSha(params.targetSha, "target SHA");
  const workflowSha = assertCommitSha(params.workflowSha, "workflow SHA");
  const packageNames = parseSelectedPackages(params.packages);
  const sources = resolveSelectedPackageSources(repoRoot, packageNames);
  assertFreshDirectory(outputDir);

  const packages = [];
  for (const source of sources) {
    const tarball = createPlaceholderTarball(source.packageName);
    const tarballName = `${source.packageName.slice(1).replaceAll("/", "-")}-${PACKAGE_VERSION}.tgz`;
    const identity = {
      integrity: npmIntegrity(tarball),
      sha256: sha256(tarball),
      shasum: npmShasum(tarball),
      sizeBytes: tarball.length,
    };
    const registry = await readStableRegistry(source.packageName, params.fetchImpl);
    const state = classifyRegistryState({
      expectedIntegrity: identity.integrity,
      expectedShasum: identity.shasum,
      packageName: source.packageName,
      registry,
    });
    writeFileSync(join(outputDir, tarballName), tarball, { flag: "wx", mode: 0o600 });
    packages.push({
      ...source,
      action: state.action,
      newPackage: state.newPackage,
      preExistingDistTags: state.nonPlaceholderTags,
      tarball: { name: tarballName, ...identity },
    });
  }

  const manifest = {
    schema: MANIFEST_SCHEMA,
    targetSha,
    workflowPath: WORKFLOW_PATH,
    workflowSha,
    version: PACKAGE_VERSION,
    publishTag: PUBLISH_TAG,
    packages,
  };
  writeFileSync(join(outputDir, MANIFEST_FILENAME), canonicalJson(manifest), {
    flag: "wx",
    mode: 0o600,
  });
  return manifest;
}

function validateManifest(value, params) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Placeholder manifest must be an object.");
  }
  const topLevelKeys = Object.keys(value).toSorted();
  if (
    JSON.stringify(topLevelKeys) !==
      JSON.stringify([
        "packages",
        "publishTag",
        "schema",
        "targetSha",
        "version",
        "workflowPath",
        "workflowSha",
      ]) ||
    value.schema !== MANIFEST_SCHEMA ||
    value.targetSha !== params.targetSha ||
    value.workflowSha !== params.workflowSha ||
    value.workflowPath !== WORKFLOW_PATH ||
    value.version !== PACKAGE_VERSION ||
    value.publishTag !== PUBLISH_TAG ||
    !Array.isArray(value.packages) ||
    value.packages.length === 0
  ) {
    throw new Error("Placeholder manifest identity does not match the approved publication.");
  }
  const names = value.packages.map((entry) => entry?.packageName);
  if (new Set(names).size !== names.length || names.some((name) => !PACKAGE_NAME_RE.test(name))) {
    throw new Error("Placeholder manifest package inventory is invalid.");
  }
  for (const entry of value.packages) {
    const entryKeys = Object.keys(entry).toSorted();
    if (
      JSON.stringify(entryKeys) !==
      JSON.stringify([
        "action",
        "newPackage",
        "packageDir",
        "packageName",
        "preExistingDistTags",
        "sourcePackageJsonSha256",
        "tarball",
      ])
    ) {
      throw new Error(`${entry.packageName}: placeholder manifest entry shape is invalid.`);
    }
    const expectedTarballName = `${entry.packageName.slice(1).replaceAll("/", "-")}-${PACKAGE_VERSION}.tgz`;
    const tarballKeys =
      entry.tarball && typeof entry.tarball === "object"
        ? Object.keys(entry.tarball).toSorted()
        : [];
    if (
      !["publish", "skip", "tag"].includes(entry.action) ||
      typeof entry.newPackage !== "boolean" ||
      !/^extensions\/[a-z0-9][a-z0-9._-]*$/u.test(entry.packageDir) ||
      !SHA256_RE.test(entry.sourcePackageJsonSha256) ||
      JSON.stringify(tarballKeys) !==
        JSON.stringify(["integrity", "name", "sha256", "shasum", "sizeBytes"]) ||
      entry.tarball.name !== expectedTarballName ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.tarball.integrity) ||
      !SHA256_RE.test(entry.tarball.sha256) ||
      !/^[0-9a-f]{40}$/u.test(entry.tarball.shasum) ||
      !Number.isSafeInteger(entry.tarball.sizeBytes) ||
      entry.tarball.sizeBytes <= 0 ||
      entry.tarball.sizeBytes > MAX_FILE_BYTES
    ) {
      throw new Error(`${entry.packageName}: placeholder manifest package binding is invalid.`);
    }
    const normalizedTags = normalizeDistTags(entry.preExistingDistTags, entry.packageName);
    if (
      Object.hasOwn(entry.preExistingDistTags, PUBLISH_TAG) ||
      JSON.stringify(normalizedTags) !== JSON.stringify(entry.preExistingDistTags) ||
      (entry.newPackage &&
        (entry.action !== "publish" || Object.keys(entry.preExistingDistTags).length !== 0)) ||
      ((entry.action === "tag" || entry.action === "skip") && entry.newPackage)
    ) {
      throw new Error(
        `${entry.packageName}: placeholder manifest dist-tag snapshot is not canonical.`,
      );
    }
  }
  return value;
}

export async function verifyPlaceholderArtifact(params) {
  const targetSha = assertCommitSha(params.targetSha, "target SHA");
  const workflowSha = assertCommitSha(params.workflowSha, "workflow SHA");
  const artifactName = assertTrimmedString(params.artifactName, "artifact name");
  const runId = Number(params.runId);
  const producerRunAttempt = Number(params.producerRunAttempt);
  if (artifactName !== `npm-placeholder-publication-${runId}-${producerRunAttempt}`) {
    throw new Error("Placeholder artifact name does not match its workflow run and attempt.");
  }
  const expected = {
    artifactDigest: assertTrimmedString(params.artifactDigest, "artifact digest"),
    artifactId: Number(params.artifactId),
    artifactName,
    artifactSizeBytes: Number(params.artifactSizeBytes),
    consumerRunAttempt: Number(params.consumerRunAttempt),
    producerJobName: "Plan npm placeholder publication",
    repository: assertTrimmedString(params.repository, "repository"),
    runAttempt: producerRunAttempt,
    runId,
    runStatePolicy: "same-run-producer-success",
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: "main",
    workflowPath: WORKFLOW_PATH,
    workflowSha,
  };
  const archive = await readPublicationArtifactArchive({
    archivePolicy: {
      minEntries: 2,
      maxEntries: 101,
      maxArchiveBytes: MAX_ARTIFACT_BYTES,
      maxExpandedBytes: MAX_ARTIFACT_BYTES,
      allowPath: (name) =>
        basename(name) === name &&
        (name === MANIFEST_FILENAME || /^[A-Za-z0-9._-]+\.tgz$/u.test(name)),
      maxEntryBytes: (name) => (name === MANIFEST_FILENAME ? MAX_FILE_BYTES : MAX_FILE_BYTES),
    },
    expected,
    maxArchiveBytes: MAX_ARTIFACT_BYTES,
    token: assertTrimmedString(params.token, "GitHub token"),
  });
  const manifestBytes = archive.files.get(MANIFEST_FILENAME);
  if (!manifestBytes) {
    throw new Error("Placeholder artifact is missing its manifest.");
  }
  const manifest = validateManifest(JSON.parse(manifestBytes.toString("utf8")), {
    targetSha,
    workflowSha,
  });
  if (archive.files.size !== manifest.packages.length + 1) {
    throw new Error("Placeholder artifact file count does not match its manifest.");
  }

  const sources = resolveSelectedPackageSources(
    params.targetRoot,
    manifest.packages.map((entry) => entry.packageName),
  );
  const sourceByName = new Map(sources.map((source) => [source.packageName, source]));
  const outputDir = resolve(params.outputDir);
  assertFreshDirectory(outputDir);
  for (const entry of manifest.packages) {
    const source = sourceByName.get(entry.packageName);
    if (
      source?.packageDir !== entry.packageDir ||
      source?.sourcePackageJsonSha256 !== entry.sourcePackageJsonSha256 ||
      !SHA256_RE.test(entry.tarball?.sha256)
    ) {
      throw new Error(`${entry.packageName}: source package binding changed.`);
    }
    const tarball = archive.files.get(entry.tarball.name);
    const expectedTarball = createPlaceholderTarball(entry.packageName);
    if (
      !tarball ||
      !tarball.equals(expectedTarball) ||
      entry.tarball.sizeBytes !== tarball.length ||
      entry.tarball.sha256 !== sha256(tarball) ||
      entry.tarball.integrity !== npmIntegrity(tarball) ||
      entry.tarball.shasum !== npmShasum(tarball)
    ) {
      throw new Error(`${entry.packageName}: placeholder tarball is not canonical.`);
    }
    writeFileSync(join(outputDir, entry.tarball.name), tarball, { flag: "wx", mode: 0o600 });
  }
  writeFileSync(join(outputDir, MANIFEST_FILENAME), canonicalJson(manifest), {
    flag: "wx",
    mode: 0o600,
  });
  return { artifactSha256: sha256Digest(archive.archiveBytes), manifest };
}

function sameTags(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertFinalRegistryState(entry, registry) {
  const state = classifyRegistryState({
    expectedIntegrity: entry.tarball.integrity,
    expectedShasum: entry.tarball.shasum,
    packageName: entry.packageName,
    registry,
  });
  if (state.action !== "skip") {
    throw new Error(`${entry.packageName}: placeholder publication did not reach its final state.`);
  }
  if (!sameTags(state.nonPlaceholderTags, entry.preExistingDistTags)) {
    throw new Error(`${entry.packageName}: a non-placeholder dist-tag changed during publication.`);
  }
}

function defaultNpmRunner(args, options) {
  const result = spawnSync("npm", args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    killSignal: "SIGTERM",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `npm ${args[0]} failed (${result.status ?? "signal"}): ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

async function readFinalRegistry(entry, params) {
  const attempts = params.registryAttempts ?? 8;
  const sleep =
    params.sleep ??
    ((delayMs) =>
      new Promise((done) => {
        setTimeout(done, delayMs);
      }));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const registry = await readRegistry(entry.packageName, params.fetchImpl);
      assertFinalRegistryState(entry, registry);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(attempt * 1000);
      }
    }
  }
  throw lastError;
}

/** @param {PublishPlaceholdersParams} params */
export async function publishPlaceholders(params) {
  const artifactDir = resolve(params.artifactDir);
  const manifest = validateManifest(
    readJsonRegularFile(join(artifactDir, MANIFEST_FILENAME), "Placeholder manifest"),
    {
      targetSha: params.targetSha,
      workflowSha: params.workflowSha,
    },
  );
  const npmToken = assertTrimmedString(params.npmToken, "NPM token");
  const publishHome = mkdtempSync(
    join(resolve(params.tempRoot ?? tmpdir()), "openclaw-npm-placeholder-"),
  );
  try {
    const npmrc = join(publishHome, "npmrc");
    writeFileSync(
      npmrc,
      `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${npmToken}\n`,
      {
        mode: 0o600,
      },
    );
    const childEnv = { ...process.env };
    delete childEnv.NPM_TOKEN;
    delete childEnv.NODE_AUTH_TOKEN;
    delete childEnv.NODE_OPTIONS;
    Object.assign(childEnv, {
      HOME: publishHome,
      NPM_CONFIG_GLOBALCONFIG: "/dev/null",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
      NPM_CONFIG_USERCONFIG: npmrc,
    });
    const npmRunner = params.npmRunner ?? defaultNpmRunner;
    const results = [];

    for (const entry of manifest.packages) {
      const current = await readRegistry(entry.packageName, params.fetchImpl);
      const state = classifyRegistryState({
        expectedIntegrity: entry.tarball.integrity,
        expectedShasum: entry.tarball.shasum,
        packageName: entry.packageName,
        registry: current,
      });
      if (!sameTags(state.nonPlaceholderTags, entry.preExistingDistTags)) {
        throw new Error(`${entry.packageName}: npm dist-tags changed after the immutable plan.`);
      }
      let mutationError;
      try {
        if (state.action === "publish") {
          npmRunner(
            [
              "publish",
              join(artifactDir, entry.tarball.name),
              "--access",
              "public",
              "--ignore-scripts",
              "--provenance",
              "--tag",
              PUBLISH_TAG,
            ],
            { cwd: artifactDir, env: childEnv },
          );
        } else if (state.action === "tag") {
          npmRunner(["dist-tag", "add", `${entry.packageName}@${PACKAGE_VERSION}`, PUBLISH_TAG], {
            cwd: artifactDir,
            env: childEnv,
          });
        }
      } catch (error) {
        mutationError = error;
      }
      try {
        await readFinalRegistry(entry, params);
      } catch (readbackError) {
        if (mutationError) {
          throw new Error(
            `${entry.packageName}: npm mutation failed and exact registry readback did not converge: ${mutationError.message}`,
            { cause: readbackError },
          );
        }
        throw readbackError;
      }
      results.push({
        action: state.action,
        newPackage: entry.newPackage,
        packageName: entry.packageName,
      });
    }
    return { results };
  } finally {
    rmSync(publishHome, { force: true, recursive: true });
  }
}

function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  if (!["create", "verify-artifact", "publish"].includes(command)) {
    throw new Error("Usage: npm-placeholder-publication.mjs <create|verify-artifact|publish> ...");
  }
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid ${command} argument near ${key ?? "<missing>"}.`);
    }
    const name = key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (values[name] !== undefined) {
      throw new Error(`Duplicate ${command} option: ${key}`);
    }
    values[name] = value;
  }
  return { command, values };
}

function appendGithubOutput(path, values) {
  if (!path) {
    return;
  }
  writeFileSync(
    path,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    { flag: "a" },
  );
}

export async function main(argv = process.argv.slice(2)) {
  const { command, values } = parseCliArgs(argv);
  if (command === "create") {
    const manifest = await createPlaceholderPublication({
      outputDir: values.outputDir,
      packages: values.packages,
      repoRoot: values.repoRoot,
      targetSha: values.targetSha,
      workflowSha: values.workflowSha,
    });
    appendGithubOutput(values.githubOutput, {
      existing_without_zero_count: manifest.packages.filter(
        (entry) => !entry.newPackage && entry.action === "publish",
      ).length,
      new_package_count: manifest.packages.filter((entry) => entry.newPackage).length,
      package_count: manifest.packages.length,
    });
    return;
  }
  if (command === "verify-artifact") {
    const result = await verifyPlaceholderArtifact({
      artifactDigest: values.artifactDigest,
      artifactId: values.artifactId,
      artifactName: values.artifactName,
      artifactSizeBytes: values.artifactSizeBytes,
      consumerRunAttempt: values.consumerRunAttempt,
      outputDir: values.outputDir,
      producerRunAttempt: values.producerRunAttempt,
      repository: values.repository,
      runId: values.runId,
      targetRoot: values.targetRoot,
      targetSha: values.targetSha,
      token: process.env.GH_TOKEN,
      workflowSha: values.workflowSha,
    });
    appendGithubOutput(values.githubOutput, { artifact_sha256: result.artifactSha256 });
    return;
  }
  const result = await publishPlaceholders({
    artifactDir: values.artifactDir,
    npmToken: process.env.NPM_TOKEN,
    targetSha: values.targetSha,
    workflowSha: values.workflowSha,
  });
  const resultPath = resolve(values.resultPath);
  writeFileSync(resultPath, canonicalJson(result), { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
