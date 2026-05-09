import { existsSync, readFileSync } from "node:fs";
import path, { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listBundledPluginMetadata } from "../bundled-plugin-metadata.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const RUNTIME_ENTRY_HELPER_RE = /(^|\/)plugin-entry\.runtime\.[cm]?[jt]s$/;
const SOURCE_MODULE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"] as const;
const FORBIDDEN_CONTRACT_MODULE_SPECIFIER_PATTERNS = [
  /^vitest$/u,
  /^openclaw\/plugin-sdk\/testing$/u,
  /(^|\/)test-api(?:\.[cm]?[jt]s)?$/u,
  /(^|\/)__tests__(\/|$)/u,
  /(^|\/)test-support(\/|$)/u,
  /(^|\/)[^/]*\.test(?:[-.][^/]*)?(?:\.[cm]?[jt]s)?$/u,
  /(^|\/)[^/]*(?:test-harness|test-plugin|test-helper|test-support|harness)[^/]*(?:\.[cm]?[jt]s)?$/u,
] as const;
const FORBIDDEN_CONTRACT_MODULE_PATH_PATTERNS = [
  /(^|\/)__tests__(\/|$)/u,
  /(^|\/)test-support(\/|$)/u,
  /(^|\/)test-api\.[cm]?[jt]s$/u,
  /(^|\/)[^/]*\.test(?:[-.][^/]*)?\.[cm]?[jt]s$/u,
  /(^|\/)[^/]*(?:test-harness|test-plugin|test-helper|test-support|harness)[^/]*\.[cm]?[jt]s$/u,
] as const;
const STATIC_FROM_IMPORT_RE =
  /^\s*import(?:\s+type)?\s+(?!["'])([\s\S]*?)\s+from\s*["']([^"']+)["']/gmu;
const STATIC_SIDE_EFFECT_IMPORT_RE = /^\s*import\s*["']([^"']+)["']/gmu;
const RE_EXPORT_STAR_RE =
  /^\s*export\s+(?:type\s+)?\*\s*(?:as\s+\w+\s+)?from\s*["']([^"']+)["']/gmu;
const RE_EXPORT_NAMED_RE = /^\s*export\s+(?:type\s+)?\{[^}]*\}\s+from\s*["']([^"']+)["']/gmu;

function listBundledPluginRoots() {
  return loadPluginManifestRegistry({})
    .plugins.filter((plugin) => plugin.origin === "bundled")
    .map((plugin) => ({
      pluginId: plugin.id,
      rootDir: plugin.workspaceDir ?? plugin.rootDir,
    }))
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
}

function resolvePublicSurfaceSourcePath(
  pluginDir: string,
  artifactBasename: string,
): string | null {
  const stem = artifactBasename.replace(/\.[^.]+$/u, "");
  for (const extension of SOURCE_MODULE_EXTENSIONS) {
    const candidate = resolve(pluginDir, `${stem}${extension}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isGuardedContractArtifactBasename(artifactBasename: string): boolean {
  return (
    artifactBasename === "channel-config-api.js" || artifactBasename.endsWith("contract-api.js")
  );
}

function collectProductionContractEntryPaths(): Array<{
  pluginId: string;
  entryPath: string;
  pluginRoot: string;
}> {
  return listBundledPluginMetadata({ rootDir: REPO_ROOT, includeChannelConfigs: false }).flatMap(
    (plugin) => {
      const pluginRoot = resolve(REPO_ROOT, "extensions", plugin.dirName);
      const entryPaths = new Set<string>();
      for (const artifact of plugin.publicSurfaceArtifacts ?? []) {
        if (!isGuardedContractArtifactBasename(artifact)) {
          continue;
        }
        const sourcePath = resolvePublicSurfaceSourcePath(pluginRoot, artifact);
        if (sourcePath) {
          entryPaths.add(sourcePath);
        }
      }
      return [...entryPaths].map((entryPath) => ({
        pluginId: plugin.manifest.id,
        entryPath,
        pluginRoot,
      }));
    },
  );
}

function formatRepoRelativePath(filePath: string): string {
  return relative(REPO_ROOT, filePath).replaceAll(path.sep, "/");
}

function stripSourceComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/(^|[^:])\/\/.*$/gmu, "$1");
}

function importsDefinePluginEntry(importClause: string | undefined): boolean {
  const namedImports = importClause?.match(/\{([\s\S]*)\}/u)?.[1];
  if (!namedImports) {
    return false;
  }

  return namedImports
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/u, ""))
    .some((part) => part.split(/\s+as\s+/u)[0]?.trim() === "definePluginEntry");
}

function analyzeSourceModule(params: { filePath: string; source: string }): {
  specifiers: string[];
  relativeSpecifiers: string[];
  importsDefinePluginEntryFromCore: boolean;
} {
  const source = stripSourceComments(params.source);
  const specifiers = new Set<string>();
  let importsDefinePluginEntryFromCore = false;

  for (const match of source.matchAll(STATIC_FROM_IMPORT_RE)) {
    const importClause = match[1];
    const specifier = match[2];
    if (!specifier) {
      continue;
    }
    specifiers.add(specifier);

    if (specifier === "openclaw/plugin-sdk/core" && importsDefinePluginEntry(importClause)) {
      importsDefinePluginEntryFromCore = true;
    }
  }

  for (const match of source.matchAll(STATIC_SIDE_EFFECT_IMPORT_RE)) {
    const specifier = match[1];
    if (specifier) {
      specifiers.add(specifier);
    }
  }

  for (const match of source.matchAll(RE_EXPORT_STAR_RE)) {
    const specifier = match[1];
    if (specifier) {
      specifiers.add(specifier);
    }
  }

  for (const match of source.matchAll(RE_EXPORT_NAMED_RE)) {
    const specifier = match[1];
    if (specifier) {
      specifiers.add(specifier);
    }
  }

  const nextSpecifiers = [...specifiers].toSorted();
  return {
    specifiers: nextSpecifiers,
    relativeSpecifiers: nextSpecifiers.filter((specifier) => specifier.startsWith(".")),
    importsDefinePluginEntryFromCore,
  };
}

function matchesForbiddenContractSpecifier(specifier: string): boolean {
  return FORBIDDEN_CONTRACT_MODULE_SPECIFIER_PATTERNS.some((pattern) => pattern.test(specifier));
}

function collectForbiddenContractSpecifiers(specifiers: readonly string[]): string[] {
  return specifiers.filter((specifier) => matchesForbiddenContractSpecifier(specifier));
}

function resolveRelativeSourceModulePath(fromPath: string, specifier: string): string | null {
  const rawTargetPath = resolve(dirname(fromPath), specifier);
  const candidates = new Set<string>();
  const rawExtension = path.extname(rawTargetPath);
  if (rawExtension) {
    candidates.add(rawTargetPath);
    const stem = rawTargetPath.slice(0, -rawExtension.length);
    for (const extension of SOURCE_MODULE_EXTENSIONS) {
      candidates.add(`${stem}${extension}`);
    }
  } else {
    for (const extension of SOURCE_MODULE_EXTENSIONS) {
      candidates.add(`${rawTargetPath}${extension}`);
      candidates.add(resolve(rawTargetPath, `index${extension}`));
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function findForbiddenContractModuleGraphPaths(params: {
  entryPath: string;
  pluginRoot: string;
}): string[] {
  const failures: string[] = [];
  const visited = new Set<string>();
  const pending = [params.entryPath];

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath || visited.has(currentPath)) {
      continue;
    }
    visited.add(currentPath);

    const repoRelativePath = formatRepoRelativePath(currentPath);
    for (const pattern of FORBIDDEN_CONTRACT_MODULE_PATH_PATTERNS) {
      if (pattern.test(repoRelativePath)) {
        failures.push(`${repoRelativePath} matched ${pattern}`);
      }
    }

    const source = readFileSync(currentPath, "utf8");
    const analysis = analyzeSourceModule({ filePath: currentPath, source });
    for (const specifier of collectForbiddenContractSpecifiers(analysis.specifiers)) {
      failures.push(`${repoRelativePath} imported ${specifier}`);
    }

    for (const specifier of analysis.relativeSpecifiers) {
      const resolvedModulePath = resolveRelativeSourceModulePath(currentPath, specifier);
      if (!resolvedModulePath) {
        continue;
      }
      if (resolvedModulePath === currentPath) {
        continue;
      }
      if (!resolvedModulePath.startsWith(params.pluginRoot + path.sep)) {
        continue;
      }
      pending.push(resolvedModulePath);
    }
  }

  return failures;
}

describe("plugin entry guardrails", () => {
  it("keeps bundled extension entry modules off direct definePluginEntry imports from core", () => {
    const failures: string[] = [];

    for (const plugin of listBundledPluginRoots()) {
      const indexPath = resolve(plugin.rootDir, "index.ts");
      try {
        const source = readFileSync(indexPath, "utf8");
        if (analyzeSourceModule({ filePath: indexPath, source }).importsDefinePluginEntryFromCore) {
          failures.push(`extensions/${plugin.pluginId}/index.ts`);
        }
      } catch {
        // Skip extensions without index.ts entry modules.
      }
    }

    expect(failures).toStrictEqual([]);
  });

  it("does not advertise runtime helper sidecars as bundled plugin entry extensions", () => {
    const failures: string[] = [];

    for (const plugin of listBundledPluginRoots()) {
      const packageJsonPath = resolve(plugin.rootDir, "package.json");
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          openclaw?: { extensions?: unknown };
        };
        const extensions = Array.isArray(pkg.openclaw?.extensions) ? pkg.openclaw.extensions : [];
        if (
          extensions.some(
            (candidate) => typeof candidate === "string" && RUNTIME_ENTRY_HELPER_RE.test(candidate),
          )
        ) {
          failures.push(`extensions/${plugin.pluginId}/package.json`);
        }
      } catch {
        // Skip directories without package metadata.
      }
    }

    expect(failures).toStrictEqual([]);
  });

  it("keeps bundled production contract barrels off test-only imports and re-exports", () => {
    const failures = collectProductionContractEntryPaths().flatMap(
      ({ pluginId, entryPath, pluginRoot }) =>
        findForbiddenContractModuleGraphPaths({
          entryPath,
          pluginRoot,
        }).map((failure) => `${pluginId}: ${failure}`),
    );

    expect(failures).toStrictEqual([]);
  });

  it("follows relative import edges while scanning guarded contract graphs", () => {
    expect(
      analyzeSourceModule({
        filePath: "guardrail-fixture.ts",
        source: `
        import { x } from "./safe.js";
        import "./setup.js";
        export { x };
        export * from "./barrel.js";
        import { y } from "openclaw/plugin-sdk/testing";
      `,
      }).relativeSpecifiers.toSorted(),
    ).toEqual(["./barrel.js", "./safe.js", "./setup.js"]);
  });

  it("guards contract-style production artifacts beyond the legacy allowlist", () => {
    expect(isGuardedContractArtifactBasename("channel-config-api.js")).toBe(true);
    expect(isGuardedContractArtifactBasename("contract-api.js")).toBe(true);
    expect(isGuardedContractArtifactBasename("doctor-contract-api.js")).toBe(true);
    expect(isGuardedContractArtifactBasename("web-search-contract-api.js")).toBe(true);
    expect(isGuardedContractArtifactBasename("test-api.js")).toBe(false);
  });

  it("flags test-support directory hops in guarded contract graphs", () => {
    expect(collectForbiddenContractSpecifiers(["./test-support/index.js"])).toEqual([
      "./test-support/index.js",
    ]);
    expect(
      FORBIDDEN_CONTRACT_MODULE_PATH_PATTERNS.some((pattern) =>
        pattern.test("extensions/demo/src/test-support/index.ts"),
      ),
    ).toBe(true);
  });

  it("detects aliased definePluginEntry imports from core", () => {
    expect(
      analyzeSourceModule({
        filePath: "aliased-plugin-entry.ts",
        source: `
          import { definePluginEntry as dpe } from "openclaw/plugin-sdk/core";
          import { somethingElse } from "openclaw/plugin-sdk/core";
        `,
      }).importsDefinePluginEntryFromCore,
    ).toBe(true);
  });
});
