#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "../src/infra/errors.ts";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../src/plugins/runtime-sidecar-paths.ts";
import { listBundledPluginPackArtifacts } from "./lib/bundled-plugin-build-entries.mjs";
import {
  collectRuntimeDependencySpecs,
  packageNameFromSpecifier,
} from "./lib/plugin-package-dependencies.mjs";
import { runInstalledWorkspaceBootstrapSmoke } from "./lib/workspace-bootstrap-smoke.mjs";
import { parseReleaseVersion, resolveNpmCommandInvocation } from "./openclaw-npm-release-check.ts";

type InstalledPackageJson = {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type InstalledBundledExtensionPackageJson = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type InstalledBundledExtensionManifestRecord = {
  id: string;
  manifest: InstalledBundledExtensionPackageJson;
  path: string;
};

const MAX_BUNDLED_EXTENSION_MANIFEST_BYTES = 1024 * 1024;
const LEGACY_CONTEXT_ENGINE_UNRESOLVED_RUNTIME_MARKER =
  "Failed to load legacy context engine runtime.";
const PUBLISHED_BUNDLED_RUNTIME_SIDECAR_PATHS = BUNDLED_RUNTIME_SIDECAR_PATHS.filter(
  (relativePath) => listBundledPluginPackArtifacts().includes(relativePath),
);
const NODE_BUILTIN_MODULES = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));
const MAX_INSTALLED_ROOT_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_INSTALLED_ROOT_DIST_JS_BYTES = 2 * 1024 * 1024;
const MAX_INSTALLED_ROOT_DIST_JS_FILES = 5000;
const ROOT_DIST_JAVASCRIPT_MODULE_FILE_RE = /\.(?:c|m)?js$/u;
const require = createRequire(import.meta.url);
const acorn = require("acorn") as typeof import("acorn");

export type PublishedInstallScenario = {
  name: string;
  installSpecs: string[];
  expectedVersion: string;
};

export function buildPublishedInstallScenarios(version: string): PublishedInstallScenario[] {
  const parsed = parseReleaseVersion(version);
  if (parsed === null) {
    throw new Error(`Unsupported release version "${version}".`);
  }

  const exactSpec = `openclaw@${version}`;
  const scenarios: PublishedInstallScenario[] = [
    {
      name: "fresh-exact",
      installSpecs: [exactSpec],
      expectedVersion: version,
    },
  ];

  if (parsed.channel === "stable" && parsed.correctionNumber !== undefined) {
    scenarios.push({
      name: "upgrade-from-base-stable",
      installSpecs: [`openclaw@${parsed.baseVersion}`, exactSpec],
      expectedVersion: version,
    });
  }

  return scenarios;
}

export function collectInstalledPackageErrors(params: {
  expectedVersion: string;
  installedVersion: string;
  packageRoot: string;
}): string[] {
  const errors: string[] = [];
  const installedVersion = normalizeInstalledBinaryVersion(params.installedVersion);

  if (installedVersion !== params.expectedVersion) {
    errors.push(
      `installed package version mismatch: expected ${params.expectedVersion}, found ${params.installedVersion || "<missing>"}.`,
    );
  }

  for (const relativePath of PUBLISHED_BUNDLED_RUNTIME_SIDECAR_PATHS) {
    if (!existsSync(join(params.packageRoot, relativePath))) {
      errors.push(`installed package is missing required bundled runtime sidecar: ${relativePath}`);
    }
  }

  errors.push(...collectInstalledContextEngineRuntimeErrors(params.packageRoot));
  errors.push(...collectInstalledRootDependencyManifestErrors(params.packageRoot));

  return errors;
}

export function normalizeInstalledBinaryVersion(output: string): string {
  const trimmed = output.trim();
  const versionMatch = /\b\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+|-beta\.\d+)?\b/u.exec(trimmed);
  return versionMatch?.[0] ?? trimmed;
}

function listDistJavaScriptFiles(
  packageRoot: string,
  opts: { skipRelativePath?: (relativePath: string) => boolean } = {},
): string[] {
  const distDir = join(packageRoot, "dist");
  if (!existsSync(distDir)) {
    return [];
  }

  const pending = [distDir];
  const files: string[] = [];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      continue;
    }
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = join(currentDir, entry.name);
      const relativePath = relative(distDir, entryPath).replaceAll("\\", "/");
      if (opts.skipRelativePath?.(relativePath)) {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.isFile() && ROOT_DIST_JAVASCRIPT_MODULE_FILE_RE.test(entry.name)) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

export function collectInstalledContextEngineRuntimeErrors(packageRoot: string): string[] {
  const errors: string[] = [];
  for (const filePath of listDistJavaScriptFiles(packageRoot)) {
    const contents = readFileSync(filePath, "utf8");
    if (contents.includes(LEGACY_CONTEXT_ENGINE_UNRESOLVED_RUNTIME_MARKER)) {
      errors.push(
        "installed package includes unresolved legacy context engine runtime loader; rebuild with a bundler-traceable LegacyContextEngine import.",
      );
      break;
    }
  }
  return errors;
}

function listInstalledRootDistJavaScriptFiles(packageRoot: string): string[] {
  return listDistJavaScriptFiles(packageRoot, {
    skipRelativePath: (relativePath) => relativePath.startsWith("extensions/"),
  });
}

type ParsedImportSpecifiersResult =
  | { ok: true; specifiers: Set<string> }
  | { ok: false; error: string };

function extractLiteralSpecifier(node: unknown): string | null {
  if (!node || typeof node !== "object") {
    return null;
  }
  const candidate = node as { type?: string; value?: unknown };
  if (candidate.type === "Literal" && typeof candidate.value === "string") {
    return candidate.value;
  }
  return null;
}

function extractJavaScriptImportSpecifiers(source: string): ParsedImportSpecifiersResult {
  const specifiers = new Set<string>();
  let program: unknown;
  try {
    program = acorn.parse(source, {
      allowHashBang: true,
      ecmaVersion: "latest",
      sourceType: "module",
    });
  } catch (error) {
    return { ok: false, error: formatErrorMessage(error) };
  }

  const visited = new Set<unknown>();
  const pending: unknown[] = [program];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const node = current as Record<string, unknown>;
    const nodeType = typeof node.type === "string" ? node.type : null;

    if (nodeType === "ImportDeclaration") {
      const specifier = extractLiteralSpecifier(node.source);
      if (specifier) {
        specifiers.add(specifier);
      }
    } else if (nodeType === "ExportAllDeclaration" || nodeType === "ExportNamedDeclaration") {
      const specifier = extractLiteralSpecifier(node.source);
      if (specifier) {
        specifiers.add(specifier);
      }
    } else if (nodeType === "ImportExpression") {
      const specifier = extractLiteralSpecifier(node.source);
      if (specifier) {
        specifiers.add(specifier);
      }
    } else if (nodeType === "CallExpression") {
      const callee = node.callee as { type?: string; name?: string } | undefined;
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (callee?.type === "Identifier" && callee.name === "require" && args.length === 1) {
        const specifier = extractLiteralSpecifier(args[0]);
        if (specifier) {
          specifiers.add(specifier);
        }
      }
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        pending.push(...value);
      } else if (value && typeof value === "object") {
        pending.push(value);
      }
    }
  }

  return { ok: true, specifiers };
}

export function collectInstalledRootDependencyManifestErrors(packageRoot: string): string[] {
  const packageJsonPath = join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    return ["installed package is missing package.json."];
  }
  const packageJsonStat = lstatSync(packageJsonPath);
  if (!packageJsonStat.isFile() || packageJsonStat.size > MAX_INSTALLED_ROOT_PACKAGE_JSON_BYTES) {
    return [
      `installed package.json is invalid or exceeds ${MAX_INSTALLED_ROOT_PACKAGE_JSON_BYTES} bytes.`,
    ];
  }
  let rootPackageJson: InstalledPackageJson;
  try {
    rootPackageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as InstalledPackageJson;
  } catch (error) {
    return [`installed package.json could not be parsed: ${formatErrorMessage(error)}.`];
  }
  const declaredRuntimeDeps = new Set([
    ...Object.keys(rootPackageJson.dependencies ?? {}),
    ...Object.keys(rootPackageJson.optionalDependencies ?? {}),
  ]);
  const distFiles = listInstalledRootDistJavaScriptFiles(packageRoot);
  if (distFiles.length > MAX_INSTALLED_ROOT_DIST_JS_FILES) {
    return [
      `installed package root dist contains ${distFiles.length} JavaScript files, exceeding the ${MAX_INSTALLED_ROOT_DIST_JS_FILES} file scan limit.`,
    ];
  }
  const missingImporters = new Map<string, Set<string>>();
  const bundledExtensionRuntimeDependencyOwners =
    collectBundledExtensionRuntimeDependencyOwners(packageRoot);

  for (const filePath of distFiles) {
    const fileStat = lstatSync(filePath);
    if (!fileStat.isFile() || fileStat.size > MAX_INSTALLED_ROOT_DIST_JS_BYTES) {
      const relativePath = relative(join(packageRoot, "dist"), filePath).replaceAll("\\", "/");
      return [
        `installed package root dist file '${relativePath}' is invalid or exceeds ${MAX_INSTALLED_ROOT_DIST_JS_BYTES} bytes.`,
      ];
    }
    const source = readFileSync(filePath, "utf8");
    const relativePath = relative(join(packageRoot, "dist"), filePath).replaceAll("\\", "/");
    const parsedSpecifiers = extractJavaScriptImportSpecifiers(source);
    if (!parsedSpecifiers.ok) {
      return [
        `installed package root dist file '${relativePath}' could not be parsed for runtime dependency verification: ${parsedSpecifiers.error}.`,
      ];
    }
    for (const specifier of parsedSpecifiers.specifiers) {
      const dependencyName = packageNameFromSpecifier(specifier);
      if (
        !dependencyName ||
        NODE_BUILTIN_MODULES.has(dependencyName) ||
        declaredRuntimeDeps.has(dependencyName) ||
        isBundledExtensionOwnedRuntimeImport({
          dependencyName,
          ownersByDependency: bundledExtensionRuntimeDependencyOwners,
          source,
        })
      ) {
        continue;
      }
      const importers = missingImporters.get(dependencyName) ?? new Set<string>();
      importers.add(relativePath);
      missingImporters.set(dependencyName, importers);
    }
  }

  return [...missingImporters.entries()]
    .map(([dependencyName, importers]) => {
      const importerList = [...importers].toSorted((left, right) => left.localeCompare(right));
      return `installed package root is missing declared runtime dependency '${dependencyName}' for dist importers: ${importerList.join(", ")}. Add it to package.json dependencies/optionalDependencies.`;
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function collectBundledExtensionRuntimeDependencyOwners(
  packageRoot: string,
): Map<string, Set<string>> {
  const ownersByDependency = new Map<string, Set<string>>();
  const { manifests } = readBundledExtensionPackageJsons(packageRoot);
  for (const { id, manifest } of manifests) {
    for (const dependencyName of collectRuntimeDependencySpecs(manifest).keys()) {
      const owners = ownersByDependency.get(dependencyName) ?? new Set<string>();
      owners.add(id);
      ownersByDependency.set(dependencyName, owners);
    }
  }
  return ownersByDependency;
}

function isBundledExtensionOwnedRuntimeImport(params: {
  dependencyName: string;
  ownersByDependency: Map<string, Set<string>>;
  source: string;
}): boolean {
  const owners = params.ownersByDependency.get(params.dependencyName);
  if (!owners) {
    return false;
  }
  return [...owners].some((pluginId) =>
    params.source.includes(`//#region extensions/${pluginId}/`),
  );
}

export function resolveInstalledBinaryPath(prefixDir: string, platform = process.platform): string {
  return platform === "win32"
    ? join(prefixDir, "openclaw.cmd")
    : join(prefixDir, "bin", "openclaw");
}

function collectExpectedBundledExtensionPackageIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const relativePath of listBundledPluginPackArtifacts()) {
    const match = /^dist\/extensions\/([^/]+)\/package\.json$/u.exec(relativePath);
    if (match) {
      ids.add(match[1]);
    }
  }
  return ids;
}

function readBundledExtensionPackageJsons(packageRoot: string): {
  manifests: InstalledBundledExtensionManifestRecord[];
  errors: string[];
} {
  const extensionsDir = join(packageRoot, "dist", "extensions");
  if (!existsSync(extensionsDir)) {
    return { manifests: [], errors: [] };
  }

  const manifests: InstalledBundledExtensionManifestRecord[] = [];
  const errors: string[] = [];
  const expectedPackageIds = collectExpectedBundledExtensionPackageIds();

  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const extensionDirPath = join(extensionsDir, entry.name);
    const packageJsonPath = join(extensionsDir, entry.name, "package.json");
    if (!existsSync(packageJsonPath)) {
      if (expectedPackageIds.has(entry.name)) {
        errors.push(`installed bundled extension manifest missing: ${packageJsonPath}.`);
      }
      continue;
    }

    try {
      const packageJsonStats = lstatSync(packageJsonPath);
      if (!packageJsonStats.isFile()) {
        throw new Error("manifest must be a regular file");
      }
      if (packageJsonStats.size > MAX_BUNDLED_EXTENSION_MANIFEST_BYTES) {
        throw new Error(`manifest exceeds ${MAX_BUNDLED_EXTENSION_MANIFEST_BYTES} bytes`);
      }

      const realExtensionDirPath = realpathSync(extensionDirPath);
      const realPackageJsonPath = realpathSync(packageJsonPath);
      const relativeManifestPath = relative(realExtensionDirPath, realPackageJsonPath);
      if (
        relativeManifestPath.length === 0 ||
        relativeManifestPath.startsWith("..") ||
        isAbsolute(relativeManifestPath)
      ) {
        throw new Error("manifest resolves outside the bundled extension directory");
      }

      manifests.push({
        id: entry.name,
        manifest: JSON.parse(
          readFileSync(realPackageJsonPath, "utf8"),
        ) as InstalledBundledExtensionPackageJson,
        path: realPackageJsonPath,
      });
    } catch (error) {
      errors.push(
        `installed bundled extension manifest invalid: failed to parse ${packageJsonPath}: ${formatErrorMessage(error)}.`,
      );
    }
  }

  return { manifests, errors };
}

function npmExec(args: string[], cwd: string): string {
  const invocation = resolveNpmCommandInvocation({
    npmExecPath: process.env.npm_execpath,
    nodeExecPath: process.execPath,
    platform: process.platform,
  });

  return execFileSync(invocation.command, [...invocation.args, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function resolveGlobalRoot(prefixDir: string, cwd: string): string {
  return npmExec(["root", "-g", "--prefix", prefixDir], cwd);
}

export function buildPublishedInstallCommandArgs(prefixDir: string, spec: string): string[] {
  return ["install", "-g", "--prefix", prefixDir, spec, "--no-fund", "--no-audit"];
}

function installSpec(prefixDir: string, spec: string, cwd: string): void {
  npmExec(buildPublishedInstallCommandArgs(prefixDir, spec), cwd);
}

function readInstalledBinaryVersion(prefixDir: string, cwd: string): string {
  return execFileSync(resolveInstalledBinaryPath(prefixDir), ["--version"], {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function verifyScenario(version: string, scenario: PublishedInstallScenario): void {
  const workingDir = mkdtempSync(join(tmpdir(), `openclaw-postpublish-${scenario.name}.`));
  const prefixDir = join(workingDir, "prefix");

  try {
    for (const spec of scenario.installSpecs) {
      installSpec(prefixDir, spec, workingDir);
    }

    const globalRoot = resolveGlobalRoot(prefixDir, workingDir);
    const packageRoot = join(globalRoot, "openclaw");
    const pkg = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as InstalledPackageJson;
    const errors = collectInstalledPackageErrors({
      expectedVersion: scenario.expectedVersion,
      installedVersion: pkg.version?.trim() ?? "",
      packageRoot,
    });
    const installedBinaryVersion = readInstalledBinaryVersion(prefixDir, workingDir);

    if (normalizeInstalledBinaryVersion(installedBinaryVersion) !== scenario.expectedVersion) {
      errors.push(
        `installed openclaw binary version mismatch: expected ${scenario.expectedVersion}, found ${installedBinaryVersion || "<missing>"}.`,
      );
    }

    if (errors.length === 0) {
      runInstalledWorkspaceBootstrapSmoke({ packageRoot });
    }

    if (errors.length > 0) {
      throw new Error(`${scenario.name} failed:\n- ${errors.join("\n- ")}`);
    }

    console.log(`openclaw-npm-postpublish-verify: ${scenario.name} OK (${version})`);
  } finally {
    rmSync(workingDir, { force: true, recursive: true });
  }
}

function main(): void {
  const version = process.argv[2]?.trim();
  if (!version) {
    throw new Error(
      "Usage: node --import tsx scripts/openclaw-npm-postpublish-verify.ts <version>",
    );
  }

  const scenarios = buildPublishedInstallScenarios(version);
  for (const scenario of scenarios) {
    verifyScenario(version, scenario);
  }

  console.log(
    `openclaw-npm-postpublish-verify: verified published npm install paths for ${version}.`,
  );
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint !== null && import.meta.url === entrypoint) {
  try {
    main();
  } catch (error) {
    console.error(`openclaw-npm-postpublish-verify: ${formatErrorMessage(error)}`);
    process.exitCode = 1;
  }
}
