import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import semverSatisfies from "semver/functions/satisfies.js";
import { resolveNpmRunner } from "./npm-runner.mjs";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readOptionalUtf8(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

function removePathIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function makeTempDir(parentDir, prefix) {
  return fs.mkdtempSync(path.join(parentDir, prefix));
}

function sanitizeTempPrefixSegment(value) {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
  return normalized.length > 0 ? normalized : "plugin";
}

function replaceDir(targetPath, sourcePath) {
  removePathIfExists(targetPath);
  try {
    fs.renameSync(sourcePath, targetPath);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
  }
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
  removePathIfExists(sourcePath);
}

function dependencyPathSegments(depName) {
  if (typeof depName !== "string" || depName.length === 0) {
    return null;
  }
  const segments = depName.split("/");
  if (depName.startsWith("@")) {
    if (segments.length !== 2) {
      return null;
    }
    const [scope, name] = segments;
    if (
      !/^@[A-Za-z0-9._-]+$/.test(scope) ||
      !/^[A-Za-z0-9._-]+$/.test(name) ||
      scope === "@." ||
      scope === "@.."
    ) {
      return null;
    }
    return [scope, name];
  }
  if (segments.length !== 1 || !/^[A-Za-z0-9._-]+$/.test(segments[0])) {
    return null;
  }
  return segments;
}

function dependencyNodeModulesPath(nodeModulesDir, depName) {
  const segments = dependencyPathSegments(depName);
  return segments ? path.join(nodeModulesDir, ...segments) : null;
}

function readInstalledDependencyVersion(nodeModulesDir, depName) {
  const depRoot = dependencyNodeModulesPath(nodeModulesDir, depName);
  if (depRoot === null) {
    return null;
  }
  const packageJsonPath = path.join(depRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  const version = readJson(packageJsonPath).version;
  return typeof version === "string" ? version : null;
}

function dependencyVersionSatisfied(spec, installedVersion) {
  return semverSatisfies(installedVersion, spec, { includePrerelease: false });
}

function readInstalledDependencyVersionFromRoot(depRoot) {
  const packageJsonPath = path.join(depRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  const version = readJson(packageJsonPath).version;
  return typeof version === "string" ? version : null;
}

const defaultStagedRuntimeDepGlobalPruneSuffixes = [".d.ts", ".map"];
const defaultStagedRuntimeDepPruneRules = new Map([
  // Type declarations only; runtime resolves through lib/es entrypoints.
  ["@larksuiteoapi/node-sdk", { paths: ["types"] }],
  [
    "@matrix-org/matrix-sdk-crypto-nodejs",
    {
      paths: ["index.d.ts", "README.md", "CHANGELOG.md", "RELEASING.md", ".node-version"],
    },
  ],
  [
    "@matrix-org/matrix-sdk-crypto-wasm",
    {
      paths: [
        "index.d.ts",
        "pkg/matrix_sdk_crypto_wasm.d.ts",
        "pkg/matrix_sdk_crypto_wasm_bg.wasm.d.ts",
        "README.md",
      ],
    },
  ],
  [
    "matrix-js-sdk",
    {
      paths: ["src", "CHANGELOG.md", "CONTRIBUTING.rst", "README.md", "release.sh"],
      suffixes: [".d.ts"],
    },
  ],
  ["matrix-widget-api", { paths: ["src"], suffixes: [".d.ts"] }],
  ["oidc-client-ts", { paths: ["README.md"], suffixes: [".d.ts"] }],
  ["music-metadata", { paths: ["README.md"], suffixes: [".d.ts"] }],
  ["@cloudflare/workers-types", { paths: ["."] }],
  ["gifwrap", { paths: ["test"] }],
  ["playwright-core", { paths: ["types"], suffixes: [".d.ts"] }],
  ["@jimp/plugin-blit", { paths: ["src/__image_snapshots__"] }],
  ["@jimp/plugin-blur", { paths: ["src/__image_snapshots__"] }],
  ["@jimp/plugin-color", { paths: ["src/__image_snapshots__"] }],
  ["@jimp/plugin-print", { paths: ["src/__image_snapshots__"] }],
  ["@jimp/plugin-quantize", { paths: ["src/__image_snapshots__"] }],
  ["@jimp/plugin-threshold", { paths: ["src/__image_snapshots__"] }],
]);
const runtimeDepsStagingVersion = 3;

function resolveRuntimeDepPruneConfig(params = {}) {
  return {
    globalPruneSuffixes:
      params.stagedRuntimeDepGlobalPruneSuffixes ?? defaultStagedRuntimeDepGlobalPruneSuffixes,
    pruneRules: params.stagedRuntimeDepPruneRules ?? defaultStagedRuntimeDepPruneRules,
  };
}

function resolveInstalledDependencyRoot(params) {
  const candidates = [];
  if (params.parentPackageRoot) {
    const nestedDepRoot = dependencyNodeModulesPath(
      path.join(params.parentPackageRoot, "node_modules"),
      params.depName,
    );
    if (nestedDepRoot !== null) {
      candidates.push(nestedDepRoot);
    }
  }
  const rootDepRoot = dependencyNodeModulesPath(params.rootNodeModulesDir, params.depName);
  if (rootDepRoot !== null) {
    candidates.push(rootDepRoot);
  }

  for (const depRoot of candidates) {
    const installedVersion = readInstalledDependencyVersionFromRoot(depRoot);
    if (installedVersion !== null && dependencyVersionSatisfied(params.spec, installedVersion)) {
      return depRoot;
    }
  }

  return null;
}

function collectInstalledRuntimeDependencyRoots(rootNodeModulesDir, dependencySpecs) {
  const packageCache = new Map();
  const directRoots = [];
  const allRoots = [];
  const queue = Object.entries(dependencySpecs).map(([depName, spec]) => ({
    depName,
    spec,
    parentPackageRoot: null,
    direct: true,
  }));
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    const depRoot = resolveInstalledDependencyRoot({
      depName: current.depName,
      spec: current.spec,
      parentPackageRoot: current.parentPackageRoot,
      rootNodeModulesDir,
    });
    if (depRoot === null) {
      return null;
    }
    const canonicalDepRoot = fs.realpathSync(depRoot);

    const seenKey = `${current.depName}\0${canonicalDepRoot}`;
    if (seen.has(seenKey)) {
      continue;
    }
    seen.add(seenKey);

    const record = { name: current.depName, root: depRoot, realRoot: canonicalDepRoot };
    allRoots.push(record);
    if (current.direct) {
      directRoots.push(record);
    }

    const packageJson =
      packageCache.get(canonicalDepRoot) ?? readJson(path.join(depRoot, "package.json"));
    packageCache.set(canonicalDepRoot, packageJson);
    for (const [childName, childSpec] of Object.entries(packageJson.dependencies ?? {})) {
      queue.push({
        depName: childName,
        spec: childSpec,
        parentPackageRoot: depRoot,
        direct: false,
      });
    }
    for (const [childName, childSpec] of Object.entries(packageJson.optionalDependencies ?? {})) {
      queue.push({
        depName: childName,
        spec: childSpec,
        parentPackageRoot: depRoot,
        direct: false,
      });
    }
  }

  return { allRoots, directRoots };
}

function pathIsInsideCopiedRoot(candidateRoot, copiedRoot) {
  return candidateRoot === copiedRoot || candidateRoot.startsWith(`${copiedRoot}${path.sep}`);
}

function findContainingRealRoot(candidatePath, allowedRealRoots) {
  return (
    allowedRealRoots.find((rootPath) => pathIsInsideCopiedRoot(candidatePath, rootPath)) ?? null
  );
}

function copyMaterializedDependencyTree(params) {
  const { activeRoots, allowedRealRoots, sourcePath, targetPath } = params;
  const sourceStats = fs.lstatSync(sourcePath);

  if (sourceStats.isSymbolicLink()) {
    let resolvedPath;
    try {
      resolvedPath = fs.realpathSync(sourcePath);
    } catch {
      return false;
    }
    const containingRoot = findContainingRealRoot(resolvedPath, allowedRealRoots);
    if (containingRoot === null) {
      return false;
    }
    if (activeRoots.has(containingRoot)) {
      return true;
    }
    const nextActiveRoots = new Set(activeRoots);
    nextActiveRoots.add(containingRoot);
    return copyMaterializedDependencyTree({
      activeRoots: nextActiveRoots,
      allowedRealRoots,
      sourcePath: resolvedPath,
      targetPath,
    });
  }

  if (sourceStats.isDirectory()) {
    fs.mkdirSync(targetPath, { recursive: true });
    for (const entry of fs
      .readdirSync(sourcePath, { withFileTypes: true })
      .toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (
        !copyMaterializedDependencyTree({
          activeRoots,
          allowedRealRoots,
          sourcePath: path.join(sourcePath, entry.name),
          targetPath: path.join(targetPath, entry.name),
        })
      ) {
        return false;
      }
    }
    return true;
  }

  if (sourceStats.isFile()) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    fs.chmodSync(targetPath, sourceStats.mode);
    return true;
  }

  return true;
}

function selectRuntimeDependencyRootsToCopy(resolution) {
  const rootsToCopy = [];

  for (const record of resolution.directRoots) {
    rootsToCopy.push(record);
  }

  for (const record of resolution.allRoots) {
    if (rootsToCopy.some((entry) => pathIsInsideCopiedRoot(record.realRoot, entry.realRoot))) {
      continue;
    }
    rootsToCopy.push(record);
  }

  return rootsToCopy;
}

function resolveInstalledDirectDependencyNames(rootNodeModulesDir, dependencySpecs) {
  const directDependencyNames = [];
  for (const [depName, spec] of Object.entries(dependencySpecs)) {
    const installedVersion = readInstalledDependencyVersion(rootNodeModulesDir, depName);
    if (installedVersion === null || !dependencyVersionSatisfied(spec, installedVersion)) {
      return null;
    }
    directDependencyNames.push(depName);
  }
  return directDependencyNames;
}

function appendDirectoryFingerprint(hash, rootDir, currentDir = rootDir) {
  const entries = fs
    .readdirSync(currentDir, { withFileTypes: true })
    .toSorted((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
    if (entry.isSymbolicLink()) {
      hash.update(`symlink:${relativePath}->${fs.readlinkSync(fullPath).replace(/\\/g, "/")}\n`);
      continue;
    }
    if (entry.isDirectory()) {
      hash.update(`dir:${relativePath}\n`);
      appendDirectoryFingerprint(hash, rootDir, fullPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const stat = fs.statSync(fullPath);
    hash.update(`file:${relativePath}:${stat.size}\n`);
    hash.update(fs.readFileSync(fullPath));
  }
}

function createInstalledRuntimeClosureFingerprint(rootNodeModulesDir, dependencyNames) {
  const hash = createHash("sha256");
  for (const depName of [...dependencyNames].toSorted((left, right) => left.localeCompare(right))) {
    const depRoot = dependencyNodeModulesPath(rootNodeModulesDir, depName);
    if (depRoot === null || !fs.existsSync(depRoot)) {
      return null;
    }
    hash.update(`package:${depName}\n`);
    appendDirectoryFingerprint(hash, depRoot);
  }
  return hash.digest("hex");
}

function resolveInstalledRuntimeClosureFingerprint(params) {
  const dependencySpecs = {
    ...params.packageJson.dependencies,
    ...params.packageJson.optionalDependencies,
  };
  if (Object.keys(dependencySpecs).length === 0 || !fs.existsSync(params.rootNodeModulesDir)) {
    return null;
  }
  const resolution = collectInstalledRuntimeDependencyRoots(
    params.rootNodeModulesDir,
    dependencySpecs,
  );
  if (resolution === null) {
    return null;
  }
  return createInstalledRuntimeClosureFingerprint(
    params.rootNodeModulesDir,
    selectRuntimeDependencyRootsToCopy(resolution).map((record) => record.name),
  );
}

function walkFiles(rootDir, visitFile) {
  if (!fs.existsSync(rootDir)) {
    return;
  }
  const queue = [rootDir];
  while (queue.length > 0) {
    const currentDir = queue.shift();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        visitFile(fullPath);
      }
    }
  }
}

function pruneDependencyFilesBySuffixes(depRoot, suffixes) {
  if (!suffixes || suffixes.length === 0 || !fs.existsSync(depRoot)) {
    return;
  }
  walkFiles(depRoot, (fullPath) => {
    if (suffixes.some((suffix) => fullPath.endsWith(suffix))) {
      removePathIfExists(fullPath);
    }
  });
}

function pruneStagedInstalledDependencyCargo(nodeModulesDir, depName, pruneConfig) {
  const depRoot = dependencyNodeModulesPath(nodeModulesDir, depName);
  if (depRoot === null) {
    return;
  }
  const pruneRule = pruneConfig.pruneRules.get(depName);
  for (const relativePath of pruneRule?.paths ?? []) {
    removePathIfExists(path.join(depRoot, relativePath));
  }
  pruneDependencyFilesBySuffixes(depRoot, pruneConfig.globalPruneSuffixes);
  pruneDependencyFilesBySuffixes(depRoot, pruneRule?.suffixes ?? []);
}

function listInstalledDependencyNames(nodeModulesDir) {
  if (!fs.existsSync(nodeModulesDir)) {
    return [];
  }
  const names = [];
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith("@")) {
      const scopeDir = path.join(nodeModulesDir, entry.name);
      for (const scopedEntry of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (scopedEntry.isDirectory()) {
          names.push(`${entry.name}/${scopedEntry.name}`);
        }
      }
      continue;
    }
    names.push(entry.name);
  }
  return names;
}

function pruneStagedRuntimeDependencyCargo(nodeModulesDir, pruneConfig) {
  for (const depName of listInstalledDependencyNames(nodeModulesDir)) {
    pruneStagedInstalledDependencyCargo(nodeModulesDir, depName, pruneConfig);
  }
}

function listBundledPluginRuntimeDirs(repoRoot) {
  const extensionsRoot = path.join(repoRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return [];
  }

  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => path.join(extensionsRoot, dirent.name))
    .filter((pluginDir) => fs.existsSync(path.join(pluginDir, "package.json")));
}

function hasRuntimeDeps(packageJson) {
  return (
    Object.keys(packageJson.dependencies ?? {}).length > 0 ||
    Object.keys(packageJson.optionalDependencies ?? {}).length > 0
  );
}

function shouldStageRuntimeDeps(packageJson) {
  return packageJson.openclaw?.bundle?.stageRuntimeDependencies === true;
}

function sanitizeBundledManifestForRuntimeInstall(pluginDir) {
  const manifestPath = path.join(pluginDir, "package.json");
  const packageJson = readJson(manifestPath);
  let changed = false;

  if (packageJson.peerDependencies) {
    delete packageJson.peerDependencies;
    changed = true;
  }

  if (packageJson.peerDependenciesMeta) {
    delete packageJson.peerDependenciesMeta;
    changed = true;
  }

  if (packageJson.devDependencies) {
    delete packageJson.devDependencies;
    changed = true;
  }

  if (changed) {
    writeJson(manifestPath, packageJson);
  }

  return packageJson;
}

function resolveRuntimeDepsStampPath(pluginDir) {
  return path.join(pluginDir, ".openclaw-runtime-deps-stamp.json");
}

function createRuntimeDepsFingerprint(packageJson, pruneConfig, params = {}) {
  const repoRoot = params.repoRoot;
  const lockfilePath =
    typeof repoRoot === "string" && repoRoot.length > 0
      ? path.join(repoRoot, "pnpm-lock.yaml")
      : null;
  const rootLockfile = lockfilePath ? readOptionalUtf8(lockfilePath) : null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        globalPruneSuffixes: pruneConfig.globalPruneSuffixes,
        packageJson,
        pruneRules: [...pruneConfig.pruneRules.entries()],
        rootInstalledRuntimeFingerprint: params.rootInstalledRuntimeFingerprint ?? null,
        rootLockfile,
        version: runtimeDepsStagingVersion,
      }),
    )
    .digest("hex");
}

function readRuntimeDepsStamp(stampPath) {
  if (!fs.existsSync(stampPath)) {
    return null;
  }
  try {
    return readJson(stampPath);
  } catch {
    return null;
  }
}

function stageInstalledRootRuntimeDeps(params) {
  const { fingerprint, packageJson, pluginDir, pruneConfig, repoRoot } = params;
  const dependencySpecs = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  };
  const rootNodeModulesDir = path.join(repoRoot, "node_modules");
  if (Object.keys(dependencySpecs).length === 0 || !fs.existsSync(rootNodeModulesDir)) {
    return false;
  }

  const directDependencyNames = resolveInstalledDirectDependencyNames(
    rootNodeModulesDir,
    dependencySpecs,
  );
  if (directDependencyNames === null) {
    return false;
  }
  const resolution = collectInstalledRuntimeDependencyRoots(rootNodeModulesDir, dependencySpecs);
  if (resolution === null) {
    return false;
  }
  const rootsToCopy = selectRuntimeDependencyRootsToCopy(resolution);
  const allowedRealRoots = rootsToCopy.map((record) => record.realRoot);

  const nodeModulesDir = path.join(pluginDir, "node_modules");
  const stampPath = resolveRuntimeDepsStampPath(pluginDir);
  const stagedNodeModulesDir = path.join(
    makeTempDir(
      os.tmpdir(),
      `openclaw-runtime-deps-${sanitizeTempPrefixSegment(path.basename(pluginDir))}-`,
    ),
    "node_modules",
  );

  try {
    for (const record of rootsToCopy.toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const sourcePath = record.realRoot;
      const targetPath = dependencyNodeModulesPath(stagedNodeModulesDir, record.name);
      if (targetPath === null) {
        return false;
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const sourceRootReal = findContainingRealRoot(sourcePath, allowedRealRoots);
      if (
        sourceRootReal === null ||
        !copyMaterializedDependencyTree({
          activeRoots: new Set([sourceRootReal]),
          allowedRealRoots,
          sourcePath,
          targetPath,
        })
      ) {
        return false;
      }
    }
    pruneStagedRuntimeDependencyCargo(stagedNodeModulesDir, pruneConfig);

    replaceDir(nodeModulesDir, stagedNodeModulesDir);
    writeJson(stampPath, {
      fingerprint,
      generatedAt: new Date().toISOString(),
    });
    return true;
  } finally {
    removePathIfExists(path.dirname(stagedNodeModulesDir));
  }
}

function installPluginRuntimeDeps(params) {
  const { fingerprint, packageJson, pluginDir, pluginId, pruneConfig, repoRoot } = params;
  if (
    repoRoot &&
    stageInstalledRootRuntimeDeps({ fingerprint, packageJson, pluginDir, pruneConfig, repoRoot })
  ) {
    return;
  }
  const nodeModulesDir = path.join(pluginDir, "node_modules");
  const stampPath = resolveRuntimeDepsStampPath(pluginDir);
  const tempInstallDir = makeTempDir(
    os.tmpdir(),
    `openclaw-runtime-deps-${sanitizeTempPrefixSegment(pluginId)}-`,
  );
  const npmRunner = resolveNpmRunner({
    npmArgs: [
      "install",
      "--omit=dev",
      "--silent",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--package-lock=false",
    ],
  });
  try {
    writeJson(path.join(tempInstallDir, "package.json"), packageJson);
    const result = spawnSync(npmRunner.command, npmRunner.args, {
      cwd: tempInstallDir,
      encoding: "utf8",
      env: npmRunner.env,
      stdio: "pipe",
      shell: npmRunner.shell,
      windowsVerbatimArguments: npmRunner.windowsVerbatimArguments,
    });
    if (result.status !== 0) {
      const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      throw new Error(
        `failed to stage bundled runtime deps for ${pluginId}: ${output || "npm install failed"}`,
      );
    }

    const stagedNodeModulesDir = path.join(tempInstallDir, "node_modules");
    if (!fs.existsSync(stagedNodeModulesDir)) {
      throw new Error(
        `failed to stage bundled runtime deps for ${pluginId}: npm install produced no node_modules directory`,
      );
    }

    pruneStagedRuntimeDependencyCargo(stagedNodeModulesDir, pruneConfig);

    replaceDir(nodeModulesDir, stagedNodeModulesDir);
    writeJson(stampPath, {
      fingerprint,
      generatedAt: new Date().toISOString(),
    });
  } finally {
    removePathIfExists(tempInstallDir);
  }
}

function installPluginRuntimeDepsWithRetries(params) {
  const { attempts = 3 } = params;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      params.install({ ...params.installParams, attempt });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }
    }
  }
  throw lastError;
}

export function stageBundledPluginRuntimeDeps(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const installPluginRuntimeDepsImpl =
    params.installPluginRuntimeDepsImpl ?? installPluginRuntimeDeps;
  const installAttempts = params.installAttempts ?? 3;
  const pruneConfig = resolveRuntimeDepPruneConfig(params);
  for (const pluginDir of listBundledPluginRuntimeDirs(repoRoot)) {
    const pluginId = path.basename(pluginDir);
    const packageJson = sanitizeBundledManifestForRuntimeInstall(pluginDir);
    const nodeModulesDir = path.join(pluginDir, "node_modules");
    const stampPath = resolveRuntimeDepsStampPath(pluginDir);
    if (!hasRuntimeDeps(packageJson) || !shouldStageRuntimeDeps(packageJson)) {
      removePathIfExists(nodeModulesDir);
      removePathIfExists(stampPath);
      continue;
    }
    const rootInstalledRuntimeFingerprint = resolveInstalledRuntimeClosureFingerprint({
      packageJson,
      rootNodeModulesDir: path.join(repoRoot, "node_modules"),
    });
    const fingerprint = createRuntimeDepsFingerprint(packageJson, pruneConfig, {
      repoRoot,
      rootInstalledRuntimeFingerprint,
    });
    const stamp = readRuntimeDepsStamp(stampPath);
    if (fs.existsSync(nodeModulesDir) && stamp?.fingerprint === fingerprint) {
      continue;
    }
    installPluginRuntimeDepsWithRetries({
      attempts: installAttempts,
      install: installPluginRuntimeDepsImpl,
      installParams: {
        fingerprint,
        packageJson,
        pluginDir,
        pluginId,
        pruneConfig,
        repoRoot,
      },
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  stageBundledPluginRuntimeDeps();
}
