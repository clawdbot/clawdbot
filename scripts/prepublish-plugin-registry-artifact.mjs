#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PREPUBLISH_PLUGIN_REGISTRY_MANIFEST = "prepublish-plugin-registry.json";
const SCHEMA = "openclaw.prepublish-plugin-registry/v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const TARBALL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u;

/**
 * @typedef {object} PrepublishPluginRegistryEntry
 * @property {string} name
 * @property {string} version
 * @property {string} tarball
 * @property {string} sha256
 */
/**
 * @typedef {object} PrepublishPluginRegistryManifest
 * @property {string} schema
 * @property {number} schemaVersion
 * @property {string} sourceSha
 * @property {string} candidateVersion
 * @property {PrepublishPluginRegistryEntry[]} packages
 */
/**
 * @typedef {object} ValidatePrepublishPluginRegistryParams
 * @property {string} artifactDir
 * @property {string} expectedCandidateVersion
 * @property {string} expectedManifestSha256
 * @property {string} expectedSourceSha
 * @property {string[]} requiredPackages
 */

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${String(error)}`, { cause: error });
  }
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function normalizeRequiredPackages(value) {
  if (
    !Array.isArray(value) ||
    value.some((name) => typeof name !== "string" || !PACKAGE_NAME_PATTERN.test(name))
  ) {
    throw new Error("required packages must be an array of npm package names");
  }
  const sorted = [...new Set(value)].toSorted((a, b) => a.localeCompare(b));
  if (sorted.length !== value.length) {
    throw new Error("required packages must not contain duplicates");
  }
  return sorted;
}

function readTarballPackageJson(tarball) {
  try {
    return JSON.parse(
      execFileSync("tar", ["-xOf", path.basename(tarball), "package/package.json"], {
        cwd: path.dirname(tarball),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    throw new Error(`cannot read package/package.json from ${tarball}: ${String(error)}`, {
      cause: error,
    });
  }
}

export function inspectNpmPackageTarball(tarball) {
  return { packageJson: readTarballPackageJson(tarball), sha256: sha256File(tarball) };
}
function validateManifestShape(manifest) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.schema !== SCHEMA ||
    manifest.schemaVersion !== 1 ||
    !SOURCE_SHA_PATTERN.test(manifest.sourceSha ?? "") ||
    typeof manifest.candidateVersion !== "string" ||
    manifest.candidateVersion.length === 0 ||
    /\s/u.test(manifest.candidateVersion) ||
    !Array.isArray(manifest.packages)
  ) {
    throw new Error("prepublish plugin registry manifest has an invalid top-level shape");
  }
  const names = new Set();
  const tarballs = new Set();
  for (const entry of manifest.packages) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !PACKAGE_NAME_PATTERN.test(entry.name ?? "") ||
      entry.version !== manifest.candidateVersion ||
      !TARBALL_PATTERN.test(entry.tarball ?? "") ||
      path.basename(entry.tarball) !== entry.tarball ||
      !SHA256_PATTERN.test(entry.sha256 ?? "")
    ) {
      throw new Error("prepublish plugin registry manifest contains an invalid package entry");
    }
    if (names.has(entry.name)) {
      throw new Error(
        `prepublish plugin registry manifest contains duplicate package ${entry.name}`,
      );
    }
    if (tarballs.has(entry.tarball)) {
      throw new Error(
        `prepublish plugin registry manifest contains duplicate tarball ${entry.tarball}`,
      );
    }
    names.add(entry.name);
    tarballs.add(entry.tarball);
  }
  const sortedNames = [...names].toSorted((a, b) => a.localeCompare(b));
  if (
    JSON.stringify(sortedNames) !== JSON.stringify(manifest.packages.map((entry) => entry.name))
  ) {
    throw new Error("prepublish plugin registry manifest packages must be sorted by name");
  }
}

/**
 * @param {ValidatePrepublishPluginRegistryParams} params
 * @returns {{ manifest: PrepublishPluginRegistryManifest, manifestPath: string, manifestSha256: string }}
 */
export function validatePrepublishPluginRegistryArtifact(params) {
  if (!SOURCE_SHA_PATTERN.test(params.expectedSourceSha ?? "")) {
    throw new Error("expectedSourceSha must be a full lowercase commit SHA");
  }
  if (
    typeof params.expectedCandidateVersion !== "string" ||
    params.expectedCandidateVersion.length === 0 ||
    /\s/u.test(params.expectedCandidateVersion)
  ) {
    throw new Error("expectedCandidateVersion must be a non-empty package version");
  }
  if (!SHA256_PATTERN.test(params.expectedManifestSha256 ?? "")) {
    throw new Error("expectedManifestSha256 must be a lowercase SHA-256");
  }
  const artifactDir = path.resolve(params.artifactDir);
  const manifestPath = path.join(artifactDir, PREPUBLISH_PLUGIN_REGISTRY_MANIFEST);
  const manifestSha256 = sha256File(manifestPath);
  if (manifestSha256 !== params.expectedManifestSha256) {
    throw new Error("prepublish plugin registry manifest SHA-256 differs from the immutable tuple");
  }
  const manifest = readJson(manifestPath, "prepublish plugin registry manifest");
  validateManifestShape(manifest);
  if (manifest.sourceSha !== params.expectedSourceSha) {
    throw new Error("prepublish plugin registry source SHA differs from the selected release SHA");
  }
  if (manifest.candidateVersion !== params.expectedCandidateVersion) {
    throw new Error("prepublish plugin registry version differs from the root package candidate");
  }
  const requiredPackages = normalizeRequiredPackages(params.requiredPackages);
  const manifestPackageNames = new Set(manifest.packages.map((entry) => entry.name));
  const missingRequiredPackage = requiredPackages.find((name) => !manifestPackageNames.has(name));
  if (missingRequiredPackage) {
    throw new Error(
      `prepublish plugin registry is missing Docker-plan package ${missingRequiredPackage}`,
    );
  }
  const expectedFiles = new Set([
    PREPUBLISH_PLUGIN_REGISTRY_MANIFEST,
    ...manifest.packages.map((entry) => entry.tarball),
  ]);
  const actualFiles = fs.readdirSync(artifactDir, { withFileTypes: true });
  if (
    actualFiles.some((entry) => !entry.isFile()) ||
    actualFiles.length !== expectedFiles.size ||
    actualFiles.some((entry) => !expectedFiles.has(entry.name))
  ) {
    throw new Error(
      "prepublish plugin registry artifact contains missing, extra, or non-file entries",
    );
  }
  for (const entry of manifest.packages) {
    const tarball = path.join(artifactDir, entry.tarball);
    if (sha256File(tarball) !== entry.sha256) {
      throw new Error(`prepublish plugin registry tarball SHA-256 mismatch for ${entry.name}`);
    }
    const packageJson = readTarballPackageJson(tarball);
    if (packageJson.name !== entry.name || packageJson.version !== entry.version) {
      throw new Error(`prepublish plugin registry tarball identity mismatch for ${entry.name}`);
    }
  }
  return { manifest, manifestPath, manifestSha256 };
}

function findPublishablePlugin(repoRoot, packageName) {
  const extensionsDir = path.join(repoRoot, "extensions");
  const matches = fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const packageFile = path.join(extensionsDir, entry.name, "package.json");
      if (!fs.existsSync(packageFile)) {
        return [];
      }
      const packageJson = readJson(packageFile, "plugin package");
      return packageJson.name === packageName
        ? [{ packageDir: `extensions/${entry.name}`, packageJson }]
        : [];
    });
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one extension package for ${packageName}; found ${matches.length}`,
    );
  }
  const match = matches[0];
  if (match.packageJson.openclaw?.release?.publishToNpm !== true) {
    throw new Error(`${packageName} is not marked openclaw.release.publishToNpm`);
  }
  return match;
}

function runChecked(command, args, cwd) {
  // The CLI stdout is a JSON contract; child build and pack diagnostics belong on stderr.
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", 2, 2] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${String(result.status)}`);
  }
}

function readPreparedRegistryPackages(preparedBundleDir, sourceSha, candidateVersion) {
  const bundle = readJson(
    path.join(preparedBundleDir, "package-bundle.json"),
    "prepared npm bundle",
  );
  if (
    bundle.schema !== "openclaw.npm-package-bundle/v1" ||
    bundle.releaseSha !== sourceSha ||
    bundle.packageName !== "openclaw" ||
    bundle.packageVersion !== candidateVersion ||
    !Array.isArray(bundle.corePackageTarballs) ||
    !Array.isArray(bundle.dependencyTarballs)
  ) {
    throw new Error("prepared npm bundle identity differs from the selected release candidate");
  }
  const packages = new Map();
  for (const entry of [bundle, ...bundle.corePackageTarballs, ...bundle.dependencyTarballs]) {
    const value = {
      name: entry.packageName,
      version: entry.packageVersion,
      tarball: entry.tarballName,
      sha256: entry.tarballSha256,
    };
    // dependencyTarballs is the root install subset of the complete core set.
    const existing = packages.get(value.name);
    if (existing && JSON.stringify(existing) !== JSON.stringify(value)) {
      throw new Error(`prepared npm bundle contains conflicting package ${value.name}`);
    }
    packages.set(value.name, value);
  }
  const entries = [...packages.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  validateManifestShape({
    schema: SCHEMA,
    schemaVersion: 1,
    sourceSha,
    candidateVersion,
    packages: entries,
  });
  return entries;
}

export function createPrepublishPluginRegistryArtifact(params) {
  const repoRoot = path.resolve(params.repoRoot);
  const outputDir = path.resolve(params.outputDir);
  const requiredPackages = normalizeRequiredPackages(params.requiredPackages);
  if (!SOURCE_SHA_PATTERN.test(params.sourceSha ?? "")) {
    throw new Error("sourceSha must be a full lowercase commit SHA");
  }
  const actualSourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  if (actualSourceSha !== params.sourceSha) {
    throw new Error("repository HEAD differs from the requested artifact source SHA");
  }
  const trackedChanges = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  if (trackedChanges) {
    throw new Error("repository has tracked changes; refusing to package them under the HEAD SHA");
  }
  const rootPackage = readJson(path.join(repoRoot, "package.json"), "root package");
  if (rootPackage.version !== params.candidateVersion) {
    throw new Error("root package version differs from the requested candidate version");
  }
  fs.mkdirSync(outputDir, { recursive: true });
  if (fs.readdirSync(outputDir).length !== 0) {
    throw new Error(`prepublish plugin registry output directory must be empty: ${outputDir}`);
  }
  const packages = params.preparedBundleDir
    ? readPreparedRegistryPackages(
        params.preparedBundleDir,
        params.sourceSha,
        params.candidateVersion,
      )
    : [];
  for (const entry of packages) {
    fs.copyFileSync(
      path.join(params.preparedBundleDir, entry.tarball),
      path.join(outputDir, entry.tarball),
      fs.constants.COPYFILE_EXCL,
    );
  }
  for (const packageName of requiredPackages) {
    if (packages.some((entry) => entry.name === packageName)) {
      continue;
    }
    const { packageDir, packageJson } = findPublishablePlugin(repoRoot, packageName);
    if (packageJson.version !== params.candidateVersion) {
      throw new Error(`${packageName} version differs from the root package candidate`);
    }
    runChecked(
      process.execPath,
      [path.join(repoRoot, "scripts/lib/plugin-npm-runtime-build.mjs"), packageDir],
      repoRoot,
    );
    const before = new Set(fs.readdirSync(outputDir));
    runChecked(
      process.execPath,
      [
        path.join(repoRoot, "scripts/lib/plugin-npm-package-manifest.mjs"),
        "--run",
        packageDir,
        "--",
        "npm",
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        outputDir,
      ],
      repoRoot,
    );
    const created = fs.readdirSync(outputDir).filter((name) => !before.has(name));
    if (created.length !== 1 || !TARBALL_PATTERN.test(created[0])) {
      throw new Error(`${packageName} pack must create exactly one .tgz`);
    }
    const tarball = created[0];
    const tarballPath = path.join(outputDir, tarball);
    const packedPackage = readTarballPackageJson(tarballPath);
    if (packedPackage.name !== packageName || packedPackage.version !== params.candidateVersion) {
      throw new Error(`${packageName} packed identity differs from the candidate`);
    }
    packages.push({
      name: packageName,
      version: params.candidateVersion,
      tarball,
      sha256: sha256File(tarballPath),
    });
  }
  const manifest = {
    schema: SCHEMA,
    schemaVersion: 1,
    sourceSha: params.sourceSha,
    candidateVersion: params.candidateVersion,
    packages: packages.toSorted((a, b) => a.name.localeCompare(b.name)),
  };
  const manifestPath = path.join(outputDir, PREPUBLISH_PLUGIN_REGISTRY_MANIFEST);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestSha256 = sha256File(manifestPath);
  return validatePrepublishPluginRegistryArtifact({
    artifactDir: outputDir,
    expectedCandidateVersion: params.candidateVersion,
    expectedManifestSha256: manifestSha256,
    expectedSourceSha: params.sourceSha,
    requiredPackages,
  });
}

function parseCliArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = new Map();
  while (args.length > 0) {
    const name = args.shift();
    const value = args.shift();
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument list near ${String(name)}`);
    }
    options.set(name, value);
  }
  const requiredPackages = JSON.parse(options.get("--required-packages-json") ?? "[]");
  return { command, options, requiredPackages };
}

function main() {
  const { command, options, requiredPackages } = parseCliArgs(process.argv.slice(2));
  const common = {
    artifactDir: options.get("--artifact-dir"),
    expectedCandidateVersion: options.get("--candidate-version"),
    expectedManifestSha256: options.get("--manifest-sha256"),
    expectedSourceSha: options.get("--source-sha"),
    requiredPackages,
  };
  const result =
    command === "create"
      ? createPrepublishPluginRegistryArtifact({
          repoRoot: options.get("--repo-root") ?? ".",
          outputDir: common.artifactDir,
          sourceSha: common.expectedSourceSha,
          candidateVersion: common.expectedCandidateVersion,
          preparedBundleDir: options.get("--prepared-bundle-dir"),
          requiredPackages,
        })
      : command === "verify"
        ? validatePrepublishPluginRegistryArtifact(common)
        : undefined;
  if (!result) {
    throw new Error("usage: prepublish-plugin-registry-artifact.mjs <create|verify> [options]");
  }
  process.stdout.write(
    `${JSON.stringify({
      manifestPath: result.manifestPath,
      manifestSha256: result.manifestSha256,
      packages: result.manifest.packages.map((entry) => entry.name),
    })}\n`,
  );
}

const isMain =
  process.argv[1] &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
