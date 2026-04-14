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

function dependencyNodeModulesPath(nodeModulesDir, depName) {
  return path.join(nodeModulesDir, ...depName.split("/"));
}

function readInstalledDependencyVersion(nodeModulesDir, depName) {
  const packageJsonPath = path.join(
    dependencyNodeModulesPath(nodeModulesDir, depName),
    "package.json",
  );
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  const version = readJson(packageJsonPath).version;
  return typeof version === "string" ? version : null;
}

function dependencyVersionSatisfied(spec, installedVersion) {
  return semverSatisfies(installedVersion, spec, { includePrerelease: false });
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
const runtimeDepsStagingVersion = 2;

function resolveRuntimeDepPruneConfig(params = {}) {
  return {
    globalPruneSuffixes:
      params.stagedRuntimeDepGlobalPruneSuffixes ?? defaultStagedRuntimeDepGlobalPruneSuffixes,
    pruneRules: params.stagedRuntimeDepPruneRules ?? defaultStagedRuntimeDepPruneRules,
  };
}

function collectInstalledRuntimeClosure(rootNodeModulesDir, dependencySpecs) {
  const packageCache = new Map();
  const closure = new Set();
  const queue = Object.entries(dependencySpecs);

  while (queue.length > 0) {
    const [depName, spec] = queue.shift();
    const installedVersion = readInstalledDependencyVersion(rootNodeModulesDir, depName);
    if (installedVersion === null || !dependencyVersionSatisfied(spec, installedVersion)) {
      return null;
    }
    if (closure.has(depName)) {
      continue;
    }

    const packageJsonPath = path.join(
      dependencyNodeModulesPath(rootNodeModulesDir, depName),
      "package.json",
    );
    const packageJson = packageCache.get(depName) ?? readJson(packageJsonPath);
    packageCache.set(depName, packageJson);
    closure.add(depName);

    for (const [childName, childSpec] of Object.entries(packageJson.dependencies ?? {})) {
      queue.push([childName, childSpec]);
    }
    for (const [childName, childSpec] of Object.entries(packageJson.optionalDependencies ?? {})) {
      queue.push([childName, childSpec]);
    }
  }

  return [...closure];
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

function createRuntimeDepsFingerprint(packageJson, pruneConfig) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        globalPruneSuffixes: pruneConfig.globalPruneSuffixes,
        packageJson,
        pruneRules: [...pruneConfig.pruneRules.entries()],
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

  const dependencyNames = collectInstalledRuntimeClosure(rootNodeModulesDir, dependencySpecs);
  if (dependencyNames === null) {
    return false;
  }

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
    for (const depName of dependencyNames) {
      const sourcePath = dependencyNodeModulesPath(rootNodeModulesDir, depName);
      const targetPath = dependencyNodeModulesPath(stagedNodeModulesDir, depName);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.cpSync(sourcePath, targetPath, { recursive: true, force: true, dereference: true });
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
    const fingerprint = createRuntimeDepsFingerprint(packageJson, pruneConfig);
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
