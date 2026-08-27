#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_FILE = "manifest.json";
const SHA256_RE = /^[a-f0-9]{64}$/u;
const COMMIT_RE = /^[a-f0-9]{40}$/u;

export function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer);
      if (read === 0) {
        break;
      }
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Prewarmed plugin cache ${label} is missing`);
  }
  return value.trim();
}

function requireRegularFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Prewarmed plugin cache ${label} must be a regular file`);
  }
}

export function verifyPrewarmedPluginCache(params) {
  const sourceDir = path.resolve(params.sourceDir);
  const sourceStat = fs.lstatSync(sourceDir);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Prewarmed plugin cache root must be a real directory");
  }
  const manifestPath = path.join(sourceDir, MANIFEST_FILE);
  requireRegularFile(manifestPath, "manifest");
  if (params.expectedManifestSha256) {
    if (!SHA256_RE.test(params.expectedManifestSha256)) {
      throw new Error("Prewarmed plugin cache expected manifest SHA-256 is invalid");
    }
    if (sha256File(manifestPath) !== params.expectedManifestSha256) {
      throw new Error("Prewarmed plugin cache manifest SHA-256 mismatch");
    }
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Prewarmed plugin cache manifest is invalid");
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error("Unsupported prewarmed plugin cache manifest schema");
  }
  const appVersion = requireString(manifest.appVersion, "app version");
  const gitCommit = requireString(manifest.gitCommit, "Git commit");
  if (appVersion !== params.expectedVersion || gitCommit !== params.expectedCommit) {
    throw new Error("Prewarmed plugin cache identity does not match its OpenClaw runtime");
  }
  if (
    !COMMIT_RE.test(gitCommit) ||
    !Array.isArray(manifest.plugins) ||
    manifest.plugins.length === 0
  ) {
    throw new Error("Prewarmed plugin cache manifest metadata is invalid");
  }
  const pluginIds = new Set();
  const packageNames = new Set();
  const archiveFiles = new Set();
  const allowedFiles = new Set([MANIFEST_FILE]);
  const plugins = manifest.plugins.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Prewarmed plugin cache entry ${index} is invalid`);
    }
    const pluginId = requireString(raw.pluginId, `entry ${index} plugin id`);
    const packageName = requireString(raw.packageName, `entry ${index} package name`);
    const packageVersion = requireString(raw.packageVersion, `entry ${index} package version`);
    const npmSpec = requireString(raw.npmSpec, `entry ${index} npm spec`);
    const archiveFile = requireString(raw.archiveFile, `entry ${index} archive file`);
    const archiveSHA256 = requireString(raw.archiveSHA256, `entry ${index} archive SHA-256`);
    if (
      path.basename(archiveFile) !== archiveFile ||
      !archiveFile.endsWith(".tgz") ||
      !SHA256_RE.test(archiveSHA256) ||
      packageVersion !== appVersion ||
      npmSpec !== `${packageName}@${packageVersion}`
    ) {
      throw new Error(`Prewarmed plugin cache entry ${pluginId} has invalid identity metadata`);
    }
    if (pluginIds.has(pluginId) || packageNames.has(packageName) || archiveFiles.has(archiveFile)) {
      throw new Error(`Prewarmed plugin cache entry ${pluginId} duplicates an identity`);
    }
    pluginIds.add(pluginId);
    packageNames.add(packageName);
    archiveFiles.add(archiveFile);
    allowedFiles.add(archiveFile);
    const archivePath = path.join(sourceDir, archiveFile);
    requireRegularFile(archivePath, `archive ${archiveFile}`);
    if (sha256File(archivePath) !== archiveSHA256) {
      throw new Error(`Prewarmed plugin cache archive SHA-256 mismatch: ${archiveFile}`);
    }
    return { pluginId, packageName, packageVersion, npmSpec, archiveFile, archiveSHA256 };
  });
  const actualFiles = fs.readdirSync(sourceDir).toSorted();
  if (
    actualFiles.some((entry) => !allowedFiles.has(entry)) ||
    actualFiles.length !== allowedFiles.size
  ) {
    throw new Error("Prewarmed plugin cache contains unexpected or missing files");
  }
  return { schemaVersion: 1, appVersion, gitCommit, plugins };
}

export function stageVerifiedPrewarmedPluginCache(params) {
  const manifest = verifyPrewarmedPluginCache(params);
  const stageDir = path.resolve(params.stageDir);
  const stageStat = fs.lstatSync(stageDir);
  if (
    !stageStat.isDirectory() ||
    stageStat.isSymbolicLink() ||
    fs.readdirSync(stageDir).length > 0
  ) {
    throw new Error("Prewarmed plugin cache staging directory must be empty");
  }
  for (const fileName of [MANIFEST_FILE, ...manifest.plugins.map((entry) => entry.archiveFile)]) {
    fs.copyFileSync(
      path.join(params.sourceDir, fileName),
      path.join(stageDir, fileName),
      fs.constants.COPYFILE_EXCL,
    );
    fs.chmodSync(path.join(stageDir, fileName), 0o644);
  }
  verifyPrewarmedPluginCache({
    sourceDir: stageDir,
    expectedVersion: params.expectedVersion,
    expectedCommit: params.expectedCommit,
    expectedManifestSha256: params.expectedManifestSha256,
  });
  return manifest;
}

function parseCli(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Invalid prewarmed cache arguments");
    }
    values.set(key, value);
  }
  return values;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseCli(process.argv.slice(2));
    stageVerifiedPrewarmedPluginCache({
      sourceDir: args.get("--source-dir"),
      stageDir: args.get("--stage-dir"),
      expectedVersion: args.get("--expected-version"),
      expectedCommit: args.get("--expected-commit"),
      expectedManifestSha256: args.get("--expected-manifest-sha256"),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
