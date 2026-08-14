#!/usr/bin/env node
// Vendors the default-enabled external macOS plugins into a prewarmed core runtime.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { collectExcludedPackagedExtensionDirs } from "./lib/packaged-extension-dirs.mts";

type JsonRecord = Record<string, unknown>;

export type MacOSPrewarmedPlugin = {
  dirName: string;
  id: string;
  packageDir: string;
  packageName: string;
  version: string;
};

type StageParams = {
  repoRoot: string;
  runtimeRoot: string;
  workDir: string;
};

const PREWARMED_ON_DEMAND_PLUGIN_IDS = new Set(["codex"]);

function readJsonFile(filePath: string): JsonRecord {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as JsonRecord;
}

function readRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function isEnabledByDefaultOnMacOS(manifest: JsonRecord): boolean {
  if (manifest.enabledByDefault === true) {
    return true;
  }
  return (
    Array.isArray(manifest.enabledByDefaultOnPlatforms) &&
    manifest.enabledByDefaultOnPlatforms.includes("darwin")
  );
}

function isPublishableToNpm(packageJson: JsonRecord): boolean {
  return readRecord(readRecord(packageJson.openclaw).release).publishToNpm === true;
}

/** Selects plugins present in a Git checkout but externalized from the core npm package. */
export function selectMacOSPrewarmedPlugins(repoRoot: string): MacOSPrewarmedPlugin[] {
  const rootPackage = readJsonFile(path.join(repoRoot, "package.json"));
  const rootVersion = normalizeOptionalString(rootPackage.version);
  if (!rootVersion) {
    throw new Error("OpenClaw package version is missing");
  }
  const externalizedDirs = collectExcludedPackagedExtensionDirs(rootPackage);
  const extensionsDir = path.join(repoRoot, "extensions");
  const selected: MacOSPrewarmedPlugin[] = [];

  for (const dirent of fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!dirent.isDirectory() || !externalizedDirs.has(dirent.name)) {
      continue;
    }
    const packageDir = path.join(extensionsDir, dirent.name);
    const manifestPath = path.join(packageDir, "openclaw.plugin.json");
    const packageJsonPath = path.join(packageDir, "package.json");
    if (!fs.existsSync(manifestPath) || !fs.existsSync(packageJsonPath)) {
      continue;
    }
    const manifest = readJsonFile(manifestPath);
    const id = normalizeOptionalString(manifest.id) ?? "";
    if (!isEnabledByDefaultOnMacOS(manifest) && !PREWARMED_ON_DEMAND_PLUGIN_IDS.has(id)) {
      continue;
    }
    const packageJson = readJsonFile(packageJsonPath);
    const packageName = normalizeOptionalString(packageJson.name);
    const version = normalizeOptionalString(packageJson.version);
    if (!id || !packageName || !version) {
      throw new Error(`Prewarmed external plugin ${dirent.name} has incomplete metadata`);
    }
    if (!isPublishableToNpm(packageJson)) {
      throw new Error(`Prewarmed external plugin ${id} is not publishable to npm`);
    }
    if (version !== rootVersion) {
      throw new Error(
        `Prewarmed external plugin ${id} version ${version} does not match OpenClaw ${rootVersion}`,
      );
    }
    selected.push({ dirName: dirent.name, id, packageDir, packageName, version });
  }

  return selected.toSorted((left, right) => left.packageName.localeCompare(right.packageName));
}

function runChecked(params: {
  command: string;
  args: string[];
  cwd: string;
  stdout?: "inherit" | "pipe";
}): string {
  const stdout = params.stdout ?? "inherit";
  const result = spawnSync(params.command, params.args, {
    cwd: params.cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", stdout, "inherit"],
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `${params.command} ${params.args.join(" ")} failed with status ${String(result.status)}`,
    );
  }
  return stdout === "pipe" ? (result.stdout ?? "") : "";
}

function packPlugin(params: {
  plugin: MacOSPrewarmedPlugin;
  packsDir: string;
  repoRoot: string;
}): string {
  const relativePackageDir = path.relative(params.repoRoot, params.plugin.packageDir);
  const generatedDistDir = path.join(params.plugin.packageDir, "dist");
  if (fs.existsSync(generatedDistDir)) {
    throw new Error(`Refusing to replace existing plugin build output: ${generatedDistDir}`);
  }
  try {
    runChecked({
      command: process.execPath,
      args: [
        path.join(params.repoRoot, "scripts/lib/plugin-npm-runtime-build.mjs"),
        relativePackageDir,
      ],
      cwd: params.repoRoot,
    });
    const before = new Set(fs.readdirSync(params.packsDir));
    runChecked({
      command: process.execPath,
      args: [
        path.join(params.repoRoot, "scripts/lib/plugin-npm-package-manifest.mjs"),
        "--run",
        relativePackageDir,
        "--",
        "npm",
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        params.packsDir,
      ],
      cwd: params.repoRoot,
      stdout: "pipe",
    });
    const created = fs
      .readdirSync(params.packsDir)
      .filter((entry) => !before.has(entry) && entry.endsWith(".tgz"));
    if (created.length !== 1) {
      throw new Error(`Packing ${params.plugin.id} created ${created.length} tarballs`);
    }
    return path.join(params.packsDir, created[0]!);
  } finally {
    fs.rmSync(generatedDistDir, { recursive: true, force: true });
  }
}

function packagePath(nodeModulesDir: string, packageName: string): string {
  return path.join(nodeModulesDir, ...packageName.split("/"));
}

function assertStagedPlugin(params: { plugin: MacOSPrewarmedPlugin; pluginDir: string }): void {
  const manifest = readJsonFile(path.join(params.pluginDir, "openclaw.plugin.json"));
  const packageJson = readJsonFile(path.join(params.pluginDir, "package.json"));
  if (normalizeOptionalString(manifest.id) !== params.plugin.id) {
    throw new Error(`Staged plugin id does not match ${params.plugin.id}`);
  }
  if (
    normalizeOptionalString(packageJson.name) !== params.plugin.packageName ||
    normalizeOptionalString(packageJson.version) !== params.plugin.version
  ) {
    throw new Error(`Staged plugin package identity does not match ${params.plugin.packageName}`);
  }
  const runtimeExtensions = readRecord(packageJson.openclaw).runtimeExtensions;
  if (!Array.isArray(runtimeExtensions) || runtimeExtensions.length === 0) {
    throw new Error(`Staged plugin ${params.plugin.id} has no runtime extensions`);
  }
  for (const entry of runtimeExtensions) {
    const relativeEntry = (normalizeOptionalString(entry) ?? "").replace(/^\.\//u, "");
    if (!relativeEntry || !fs.existsSync(path.join(params.pluginDir, relativeEntry))) {
      throw new Error(
        `Staged plugin ${params.plugin.id} is missing runtime entry ${String(entry)}`,
      );
    }
  }
}

/** Copies npm-prepared plugin packages into the trusted bundled-plugin tree. */
export function copyPreparedMacOSPlugins(params: {
  plugins: readonly MacOSPrewarmedPlugin[];
  runtimeRoot: string;
  vendorNodeModulesDir: string;
}): void {
  const extensionsDir = path.join(params.runtimeRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    throw new Error(`Prewarmed runtime extensions directory is missing: ${extensionsDir}`);
  }
  for (const plugin of params.plugins) {
    const sourceDir = packagePath(params.vendorNodeModulesDir, plugin.packageName);
    const targetDir = path.join(extensionsDir, plugin.dirName);
    if (!fs.existsSync(sourceDir)) {
      throw new Error(`Prepared plugin package is missing: ${sourceDir}`);
    }
    if (fs.existsSync(targetDir)) {
      throw new Error(`Refusing to replace existing bundled plugin: ${targetDir}`);
    }
    fs.cpSync(sourceDir, targetDir, { recursive: true, dereference: true });
    assertStagedPlugin({ plugin, pluginDir: targetDir });
  }
}

function stageMacOSPrewarmedPlugins(params: StageParams): MacOSPrewarmedPlugin[] {
  const repoRoot = path.resolve(params.repoRoot);
  const runtimeRoot = path.resolve(params.runtimeRoot);
  const workDir = path.resolve(params.workDir);
  const packsDir = path.join(workDir, "packs");
  const vendorDir = path.join(workDir, "vendor");
  fs.mkdirSync(packsDir, { recursive: true });
  fs.mkdirSync(vendorDir, { recursive: true });
  if (fs.readdirSync(packsDir).length > 0 || fs.readdirSync(vendorDir).length > 0) {
    throw new Error(`Prewarmed plugin staging directory must be empty: ${workDir}`);
  }

  const plugins = selectMacOSPrewarmedPlugins(repoRoot);
  if (plugins.length === 0) {
    throw new Error("No prewarmed external macOS plugins were selected");
  }
  const dependencies: Record<string, string> = {};
  for (const [index, plugin] of plugins.entries()) {
    console.error(`[prewarm] packing plugin ${index + 1}/${plugins.length}: ${plugin.id}`);
    dependencies[plugin.packageName] = `file:${packPlugin({ plugin, packsDir, repoRoot })}`;
  }
  fs.writeFileSync(
    path.join(vendorDir, "package.json"),
    `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`,
    "utf8",
  );
  runChecked({
    command: "npm",
    args: [
      "install",
      "--install-strategy=nested",
      "--omit=dev",
      "--omit=peer",
      "--legacy-peer-deps",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--loglevel=error",
    ],
    cwd: vendorDir,
  });
  copyPreparedMacOSPlugins({
    plugins,
    runtimeRoot,
    vendorNodeModulesDir: path.join(vendorDir, "node_modules"),
  });
  console.error(`[prewarm] staged ${plugins.length} external macOS plugins`);
  return plugins;
}

function parseArgs(argv: string[]): StageParams {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(
        "usage: stage-macos-prewarmed-plugins --repo-root <dir> --runtime-root <dir> --work-dir <dir>",
      );
    }
    values.set(key, value);
  }
  const repoRoot = values.get("--repo-root");
  const runtimeRoot = values.get("--runtime-root");
  const workDir = values.get("--work-dir");
  if (!repoRoot || !runtimeRoot || !workDir || values.size !== 3) {
    throw new Error(
      "usage: stage-macos-prewarmed-plugins --repo-root <dir> --runtime-root <dir> --work-dir <dir>",
    );
  }
  return { repoRoot, runtimeRoot, workDir };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    stageMacOSPrewarmedPlugins(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
