import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { pluginSdkEntrypoints } from "../../plugin-sdk/entrypoints.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../test-helpers/fs-fixtures.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(ROOT_DIR, "..");
const PUBLIC_CONTRACT_REFERENCE_FILES = [
  "docs/plugins/architecture.md",
  "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
] as const;
const PLUGIN_SDK_SUBPATH_PATTERN = /openclaw\/plugin-sdk\/([a-z0-9][a-z0-9-]*)\b/g;
const NPM_PACK_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>^%\r\n]/;
const tempDirs: string[] = [];

function collectPluginSdkPackageExports(): string[] {
  const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
  };
  const exports = packageJson.exports ?? {};
  const subpaths: string[] = [];
  for (const key of Object.keys(exports)) {
    if (key === "./plugin-sdk") {
      subpaths.push("index");
      continue;
    }
    if (!key.startsWith("./plugin-sdk/")) {
      continue;
    }
    subpaths.push(key.slice("./plugin-sdk/".length));
  }
  return subpaths.toSorted();
}

function collectPluginSdkSubpathReferences() {
  const references: Array<{ file: string; subpath: string }> = [];
  for (const file of PUBLIC_CONTRACT_REFERENCE_FILES) {
    const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
    for (const match of source.matchAll(PLUGIN_SDK_SUBPATH_PATTERN)) {
      const subpath = match[1];
      if (!subpath) {
        continue;
      }
      references.push({ file, subpath });
    }
  }
  return references;
}

function readRootPackageJson(): {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
}

function readMatrixPackageJson(): {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, "extensions/matrix/package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
}

function collectRuntimeDependencySpecs(packageJson: {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}): Map<string, string> {
  return new Map([
    ...Object.entries(packageJson.dependencies ?? {}),
    ...Object.entries(packageJson.optionalDependencies ?? {}),
  ]);
}

function createRootPackageRequire() {
  return createRequire(pathToFileURL(resolve(REPO_ROOT, "package.json")).href);
}

function isNpmExecPath(value: string): boolean {
  return /^npm(?:-cli)?(?:\.(?:c?js|cmd|exe))?$/.test(
    value.split(/[\\/]/).at(-1)?.toLowerCase() ?? "",
  );
}

function escapeForCmdExe(arg: string): string {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(`unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}`);
  }
  if (!arg.includes(" ") && !arg.includes('"')) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

function buildCmdExeCommandLine(command: string, args: string[]): string {
  return [escapeForCmdExe(command), ...args.map(escapeForCmdExe)].join(" ");
}

type NpmCommandInvocation = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
};

function resolveNpmCommandInvocation(npmArgs: string[]): NpmCommandInvocation {
  const npmExecPath = process.env.npm_execpath;
  if (typeof npmExecPath === "string" && npmExecPath.length > 0 && isNpmExecPath(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...npmArgs] };
  }

  if (process.platform !== "win32") {
    return { command: "npm", args: npmArgs };
  }

  const nodeDir = dirname(process.execPath);
  const npmCliCandidates = [
    resolve(nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"),
    resolve(nodeDir, "node_modules/npm/bin/npm-cli.js"),
  ];
  const npmCliPath = npmCliCandidates.find((candidate) => existsSync(candidate));
  if (npmCliPath) {
    return { command: process.execPath, args: [npmCliPath, ...npmArgs] };
  }

  const npmExePath = resolve(nodeDir, "npm.exe");
  if (existsSync(npmExePath)) {
    return { command: npmExePath, args: npmArgs };
  }

  const npmCmdPath = resolve(nodeDir, "npm.cmd");
  if (existsSync(npmCmdPath)) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(npmCmdPath, npmArgs)],
      windowsVerbatimArguments: true,
    };
  }

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", buildCmdExeCommandLine("npm.cmd", npmArgs)],
    windowsVerbatimArguments: true,
  };
}

function packOpenClawToTempDir(packDir: string): string {
  const invocation = resolveNpmCommandInvocation([
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    packDir,
  ]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ...invocation.env,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    },
    maxBuffer: NPM_PACK_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "npm pack failed").trim());
  }
  const raw = result.stdout;
  const parsed = JSON.parse(raw) as Array<{ filename?: string }>;
  const filename = parsed[0]?.filename?.trim();
  if (!filename) {
    throw new Error(`npm pack did not return a filename: ${raw}`);
  }
  return join(packDir, filename);
}

async function readPackedRootPackageJson(archivePath: string): Promise<{
  dependencies?: Record<string, string>;
}> {
  const extractDir = makeTrackedTempDir("openclaw-packed-root-package-json", tempDirs);
  await tar.x({
    file: archivePath,
    cwd: extractDir,
    filter: (entryPath) => entryPath === "package/package.json",
    strict: true,
  });
  return JSON.parse(readFileSync(join(extractDir, "package", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
}

function collectExtensionFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const nextPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectExtensionFiles(nextPath));
      continue;
    }
    if (!entry.isFile() || !/\.(?:[cm]?ts|tsx|mts|cts)$/.test(entry.name)) {
      continue;
    }
    files.push(nextPath);
  }
  return files;
}

function collectExtensionCoreImportLeaks(): Array<{ file: string; specifier: string }> {
  const leaks: Array<{ file: string; specifier: string }> = [];
  const importPattern = /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']((?:\.\.\/)+src\/[^"']+)["']/g;
  for (const file of collectExtensionFiles(resolve(REPO_ROOT, "extensions"))) {
    const repoRelativePath = relative(REPO_ROOT, file).replaceAll("\\", "/");
    if (
      /(?:^|\/)(?:__tests__|tests|test-support)(?:\/|$)/.test(repoRelativePath) ||
      /(?:^|\/)test-support\.[cm]?tsx?$/.test(repoRelativePath) ||
      /\.test\.[cm]?tsx?$/.test(repoRelativePath)
    ) {
      continue;
    }
    const extensionRootMatch = /^(.*?\/extensions\/[^/]+)/.exec(file.replaceAll("\\", "/"));
    const extensionRoot = extensionRootMatch?.[1];
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier) {
        continue;
      }
      const resolvedSpecifier = resolve(dirname(file), specifier).replaceAll("\\", "/");
      if (extensionRoot && resolvedSpecifier.startsWith(`${extensionRoot}/`)) {
        continue;
      }
      leaks.push({
        file: repoRelativePath,
        specifier,
      });
    }
  }
  return leaks;
}

describe("plugin-sdk package contract guardrails", () => {
  afterEach(() => {
    cleanupTrackedTempDirs(tempDirs);
  });

  it("keeps package.json exports aligned with built plugin-sdk entrypoints", () => {
    expect(collectPluginSdkPackageExports()).toEqual([...pluginSdkEntrypoints].toSorted());
  });

  it("keeps curated public plugin-sdk references on exported built subpaths", () => {
    const entrypoints = new Set(pluginSdkEntrypoints);
    const exports = new Set(collectPluginSdkPackageExports());
    const failures: string[] = [];

    for (const reference of collectPluginSdkSubpathReferences()) {
      const missingFrom: string[] = [];
      if (!entrypoints.has(reference.subpath)) {
        missingFrom.push("scripts/lib/plugin-sdk-entrypoints.json");
      }
      if (!exports.has(reference.subpath)) {
        missingFrom.push("package.json exports");
      }
      if (missingFrom.length === 0) {
        continue;
      }
      failures.push(
        `${reference.file} references openclaw/plugin-sdk/${reference.subpath}, but ${reference.subpath} is missing from ${missingFrom.join(" and ")}`,
      );
    }

    expect(failures).toEqual([]);
  });

  it("mirrors matrix runtime deps needed by the bundled host graph", () => {
    const rootRuntimeDeps = collectRuntimeDependencySpecs(readRootPackageJson());
    const matrixPackageJson = readMatrixPackageJson();
    const matrixRuntimeDeps = collectRuntimeDependencySpecs(matrixPackageJson);

    for (const dep of [
      "@matrix-org/matrix-sdk-crypto-wasm",
      "@matrix-org/matrix-sdk-crypto-nodejs",
      "fake-indexeddb",
      "matrix-js-sdk",
    ]) {
      expect(rootRuntimeDeps.get(dep)).toBe(matrixRuntimeDeps.get(dep));
    }
  });

  it("resolves matrix crypto WASM from the root runtime surface", () => {
    const rootRequire = createRootPackageRequire();
    // Normalize filesystem separators so the package assertion stays portable.
    const resolvedPath = rootRequire
      .resolve("@matrix-org/matrix-sdk-crypto-wasm")
      .replaceAll("\\", "/");

    expect(resolvedPath).toContain("@matrix-org/matrix-sdk-crypto-wasm");
  });

  it("keeps matrix crypto WASM in the packed artifact manifest", async () => {
    const tempRoot = makeTrackedTempDir("openclaw-matrix-wasm-pack", tempDirs);
    const packDir = join(tempRoot, "pack");
    mkdirSync(packDir, { recursive: true });

    const archivePath = packOpenClawToTempDir(packDir);
    const packedPackageJson = await readPackedRootPackageJson(archivePath);
    const matrixPackageJson = readMatrixPackageJson();
    expect(packedPackageJson.dependencies?.["@matrix-org/matrix-sdk-crypto-wasm"]).toBe(
      matrixPackageJson.dependencies?.["@matrix-org/matrix-sdk-crypto-wasm"],
    );
    expect(packedPackageJson.dependencies?.["@openclaw/plugin-package-contract"]).toBeUndefined();
  });

  it("keeps extension sources on public sdk or local package seams", () => {
    expect(collectExtensionCoreImportLeaks()).toEqual([]);
  });
});
