import fs from "node:fs";
import path from "node:path";
import { dependencyNodeModulesPath } from "./bundled-runtime-deps-package-tree.mjs";
import { removePathIfExists } from "./bundled-runtime-deps-stage-state.mjs";

const defaultStagedRuntimeDepGlobalPruneSuffixes = [".d.ts", ".map"];
const defaultStagedRuntimeDepGlobalPruneDirectories = [
  "__snapshots__",
  "__tests__",
  "test",
  "tests",
];
const defaultStagedRuntimeDepGlobalPruneFilePatterns = [
  /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u,
];
const defaultStagedRuntimeDepPruneRules = new Map([
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
  ["tokenjuice", { keepDirectories: ["dist/rules/tests"] }],
]);

export function resolveRuntimeDepPruneConfig(params = {}) {
  return {
    globalPruneDirectories:
      params.stagedRuntimeDepGlobalPruneDirectories ??
      defaultStagedRuntimeDepGlobalPruneDirectories,
    globalPruneFilePatterns:
      params.stagedRuntimeDepGlobalPruneFilePatterns ??
      defaultStagedRuntimeDepGlobalPruneFilePatterns,
    globalPruneSuffixes:
      params.stagedRuntimeDepGlobalPruneSuffixes ?? defaultStagedRuntimeDepGlobalPruneSuffixes,
    pruneRules: params.stagedRuntimeDepPruneRules ?? defaultStagedRuntimeDepPruneRules,
  };
}

function walkFiles(rootDir, visitFile) {
  if (!fs.existsSync(rootDir)) {
    return;
  }
  const queue = [rootDir];
  for (let index = 0; index < queue.length; index += 1) {
    const currentDir = queue[index];
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

function relativePathSegments(rootDir, fullPath) {
  return path.relative(rootDir, fullPath).split(path.sep).filter(Boolean);
}

function isNodeModulesPackageRoot(segments, index) {
  const parent = segments[index - 1];
  if (parent === "node_modules") {
    return true;
  }
  return parent?.startsWith("@") === true && segments[index - 2] === "node_modules";
}

function pruneDependencyDirectoriesByBasename(depRoot, basenames, keepDirs = new Set()) {
  if (!basenames || basenames.length === 0 || !fs.existsSync(depRoot)) {
    return;
  }
  const basenameSet = new Set(basenames);
  const queue = [depRoot];
  for (let index = 0; index < queue.length; index += 1) {
    const currentDir = queue[index];
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      const segments = relativePathSegments(depRoot, fullPath);
      if (basenameSet.has(entry.name) && !isNodeModulesPackageRoot(segments, segments.length - 1)) {
        if (keepDirs.has(fullPath)) {
          queue.push(fullPath);
          continue;
        }
        removePathIfExists(fullPath);
        continue;
      }
      queue.push(fullPath);
    }
  }
}

function pruneDependencyFilesByPatterns(depRoot, patterns) {
  if (!patterns || patterns.length === 0 || !fs.existsSync(depRoot)) {
    return;
  }
  walkFiles(depRoot, (fullPath) => {
    const relativePath = relativePathSegments(depRoot, fullPath).join("/");
    if (patterns.some((pattern) => pattern.test(relativePath))) {
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
  const keepDirs = new Set(
    (pruneRule?.keepDirectories ?? []).map((relativePath) => path.resolve(depRoot, relativePath)),
  );
  pruneDependencyDirectoriesByBasename(depRoot, pruneConfig.globalPruneDirectories, keepDirs);
  pruneDependencyFilesByPatterns(depRoot, pruneConfig.globalPruneFilePatterns);
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

export function pruneStagedRuntimeDependencyCargo(nodeModulesDir, pruneConfig) {
  for (const depName of listInstalledDependencyNames(nodeModulesDir)) {
    pruneStagedInstalledDependencyCargo(nodeModulesDir, depName, pruneConfig);
  }
}
