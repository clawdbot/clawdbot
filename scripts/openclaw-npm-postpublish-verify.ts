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
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "../src/infra/errors.ts";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../src/plugins/runtime-sidecar-paths.ts";
import {
  collectBundledPluginRootRuntimeMirrorErrors,
  collectRootDistBundledRuntimeMirrors,
  collectRuntimeDependencySpecs,
} from "./lib/bundled-plugin-root-runtime-mirrors.mjs";
import { NPM_UPDATE_COMPAT_SIDECAR_PATHS } from "./lib/npm-update-compat-sidecars.mjs";
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
const NPM_UPDATE_COMPAT_EXTENSION_DIRS = new Set(
  [...NPM_UPDATE_COMPAT_SIDECAR_PATHS].map((relativePath) => {
    const pathParts = relativePath.split("/");
    pathParts.pop();
    return pathParts.join("/");
  }),
);

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

  for (const relativePath of BUNDLED_RUNTIME_SIDECAR_PATHS) {
    if (!existsSync(join(params.packageRoot, relativePath))) {
      errors.push(`installed package is missing required bundled runtime sidecar: ${relativePath}`);
    }
  }

  errors.push(...collectInstalledContextEngineRuntimeErrors(params.packageRoot));
  errors.push(...collectInstalledMirroredRootDependencyManifestErrors(params.packageRoot));

  return errors;
}

export function normalizeInstalledBinaryVersion(output: string): string {
  const trimmed = output.trim();
  const versionMatch = /\b\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+|-beta\.\d+)?\b/u.exec(trimmed);
  return versionMatch?.[0] ?? trimmed;
}

function listDistJavaScriptFiles(packageRoot: string): string[] {
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
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".js")) {
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

export function resolveInstalledBinaryPath(prefixDir: string, platform = process.platform): string {
  return platform === "win32"
    ? join(prefixDir, "openclaw.cmd")
    : join(prefixDir, "bin", "openclaw");
}

function collectExpectedBundledExtensionPackageIds(
  sourceExtensionsDir = join(process.cwd(), "extensions"),
): ReadonlySet<string> | null {
  if (!existsSync(sourceExtensionsDir)) {
    return null;
  }

  const ids = new Set<string>();
  for (const entry of readdirSync(sourceExtensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (existsSync(join(sourceExtensionsDir, entry.name, "package.json"))) {
      ids.add(entry.name);
    }
  }
  return ids;
}

function isNpmUpdateCompatOnlyExtensionDir(params: {
  extensionId: string;
  packageRoot: string;
}): boolean {
  const relativeExtensionDir = `dist/extensions/${params.extensionId}`;
  if (!NPM_UPDATE_COMPAT_EXTENSION_DIRS.has(relativeExtensionDir)) {
    return false;
  }

  return [...NPM_UPDATE_COMPAT_SIDECAR_PATHS]
    .filter((relativePath) => relativePath.startsWith(`${relativeExtensionDir}/`))
    .every((relativePath) => existsSync(join(params.packageRoot, relativePath)));
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
      if (isNpmUpdateCompatOnlyExtensionDir({ extensionId: entry.name, packageRoot })) {
        continue;
      }
      if (expectedPackageIds === null || expectedPackageIds.has(entry.name)) {
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

export function collectInstalledMirroredRootDependencyManifestErrors(
  packageRoot: string,
): string[] {
  const packageJsonPath = join(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    return ["installed package is missing package.json."];
  }

  const rootPackageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as InstalledPackageJson;
  const { manifests, errors } = readBundledExtensionPackageJsons(packageRoot);
  const bundledRuntimeDependencySpecs = new Map<
    string,
    { conflicts: Array<{ pluginId: string; spec: string }>; pluginIds: string[]; spec: string }
  >();

  for (const { id, manifest: extensionPackageJson } of manifests) {
    const extensionRuntimeDeps = collectRuntimeDependencySpecs(extensionPackageJson);
    for (const [dependencyName, spec] of extensionRuntimeDeps) {
      const existing = bundledRuntimeDependencySpecs.get(dependencyName);
      if (existing) {
        if (existing.spec !== spec) {
          existing.conflicts.push({ pluginId: id, spec });
        } else if (!existing.pluginIds.includes(id)) {
          existing.pluginIds.push(id);
        }
        continue;
      }
      bundledRuntimeDependencySpecs.set(dependencyName, { conflicts: [], pluginIds: [id], spec });
    }
  }

  const requiredRootMirrors = collectRootDistBundledRuntimeMirrors({
    bundledRuntimeDependencySpecs,
    distDir: join(packageRoot, "dist"),
  });
  errors.push(
    ...collectBundledPluginRootRuntimeMirrorErrors({
      bundledRuntimeDependencySpecs,
      requiredRootMirrors,
      rootPackageJson,
    }),
  );

  return errors;
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
