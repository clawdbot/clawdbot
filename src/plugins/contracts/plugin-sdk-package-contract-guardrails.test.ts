import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pluginSdkEntrypoints } from "../../plugin-sdk/entrypoints.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(ROOT_DIR, "..");
const PUBLIC_CONTRACT_REFERENCE_FILES = [
  "docs/plugins/architecture.md",
  "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
] as const;
const PLUGIN_SDK_SUBPATH_PATTERN = /openclaw\/plugin-sdk\/([a-z0-9][a-z0-9-]*)\b/g;

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

  it("keeps Matrix runtime deps local to the Matrix plugin", () => {
    const rootRuntimeDeps = collectRuntimeDependencySpecs(readRootPackageJson());
    const matrixPackageJson = readMatrixPackageJson();
    const matrixRuntimeDeps = collectRuntimeDependencySpecs(matrixPackageJson);

    for (const dep of [
      "@matrix-org/matrix-sdk-crypto-wasm",
      "@matrix-org/matrix-sdk-crypto-nodejs",
      "fake-indexeddb",
      "matrix-js-sdk",
    ]) {
      expect(matrixRuntimeDeps.get(dep)).toBeDefined();
      expect(rootRuntimeDeps.has(dep)).toBe(false);
    }
    expect(rootRuntimeDeps.has("@openclaw/plugin-package-contract")).toBe(false);
  });

  it("keeps extension sources on public sdk or local package seams", () => {
    expect(collectExtensionCoreImportLeaks()).toEqual([]);
  });
});
