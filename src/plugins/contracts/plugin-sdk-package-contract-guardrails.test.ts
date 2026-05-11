import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deprecatedBarrelPluginSdkEntrypoints,
  deprecatedPublicPluginSdkEntrypoints,
  privateLocalOnlyPluginSdkEntrypoints,
  pluginSdkEntrypoints,
  publicPluginOwnedSdkEntrypoints,
  publicPluginSdkEntrypoints,
  reservedBundledPluginSdkEntrypoints,
  supportedBundledFacadeSdkEntrypoints,
} from "../../plugin-sdk/entrypoints.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(ROOT_DIR, "..");
const SDK_SUBPATH_DOC_FILE = "docs/plugins/sdk-subpaths.md";
const PUBLIC_CONTRACT_REFERENCE_FILES = [
  "docs/plugins/architecture.md",
  "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
] as const;
const PLUGIN_SDK_SUBPATH_PATTERN = /openclaw\/plugin-sdk\/([a-z0-9][a-z0-9-]*)\b/g;
const BUNDLED_PLUGIN_FACADE_LOADER_PATTERN =
  /\bload(?:Activated)?BundledPluginPublicSurfaceModuleSync\b/;
const PRIVATE_BUNDLED_SDK_SURFACE_PATTERN =
  /\b(?:Private helper surface|Narrow plugin-sdk surface for the bundled|Narrow .*runtime exports used by the bundled)\b/i;
const GENERIC_CORE_HELPER_FILES = ["src/polls.ts", "src/poll-params.ts"] as const;
const GENERIC_CORE_PLUGIN_OWNER_NAME_PATTERN =
  /\b(?:imessage|discord|feishu|googlechat|matrix|mattermost|msteams|slack|telegram|whatsapp|zalo|zalouser)\b/gi;
const PACKAGE_CONTRACT_SCAN_TIMEOUT_MS = 240_000;
const DEPRECATED_EXTENSION_SDK_SPECIFIERS = new Set([
  "openclaw/plugin-sdk",
  "openclaw/plugin-sdk/channel-config-schema-legacy",
  "openclaw/plugin-sdk/compat",
  "openclaw/plugin-sdk/testing",
  "openclaw/plugin-sdk/test-utils",
]);
const DEPRECATED_TEST_BARREL_SPECIFIERS = new Set([
  "openclaw/plugin-sdk/testing",
  "openclaw/plugin-sdk/test-utils",
]);
const DEPRECATED_TEST_BARREL_ALLOWED_REFERENCE_FILES = new Set([
  "src/plugin-sdk/testing.ts",
  "src/plugin-sdk/test-utils.ts",
  "packages/plugin-sdk/src/testing.ts",
  "src/plugins/compat/registry.ts",
  "src/plugins/contracts/plugin-entry-guardrails.test.ts",
  "src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts",
]);

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

function collectDocumentedSdkSubpaths(): Set<string> {
  const source = readFileSync(resolve(REPO_ROOT, SDK_SUBPATH_DOC_FILE), "utf8");
  return new Set(
    [...source.matchAll(/`plugin-sdk\/([a-z0-9][a-z0-9-]*)`/g)]
      .map((match) => match[1])
      .filter((subpath): subpath is string => Boolean(subpath)),
  );
}

function collectBundledPluginIds(): string[] {
  return readdirSync(resolve(REPO_ROOT, "extensions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((a, b) => b.length - a.length || a.localeCompare(b));
}

function collectPluginOwnedSdkEntrypoints(): string[] {
  const pluginIds = collectBundledPluginIds();
  return pluginSdkEntrypoints
    .filter((entrypoint) =>
      pluginIds.some(
        (pluginId) => entrypoint === pluginId || entrypoint.startsWith(`${pluginId}-`),
      ),
    )
    .toSorted();
}

function resolvePluginOwnerFromEntrypoint(entrypoint: string): string | undefined {
  return collectBundledPluginIds().find(
    (pluginId) => entrypoint === pluginId || entrypoint.startsWith(`${pluginId}-`),
  );
}

function collectClassificationOverlaps(classifications: Record<string, readonly string[]>) {
  const seen = new Map<string, string[]>();
  for (const [classification, entrypoints] of Object.entries(classifications)) {
    for (const entrypoint of entrypoints) {
      const current = seen.get(entrypoint) ?? [];
      current.push(classification);
      seen.set(entrypoint, current);
    }
  }
  return [...seen.entries()]
    .filter(([, matches]) => matches.length > 1)
    .map(([entrypoint, matches]) => `${entrypoint}: ${matches.toSorted().join(", ")}`)
    .toSorted();
}

function collectBundledFacadeSdkEntrypoints(): string[] {
  const entrypoints: string[] = [];
  for (const entrypoint of pluginSdkEntrypoints) {
    const filePath = resolve(REPO_ROOT, "src/plugin-sdk", `${entrypoint}.ts`);
    const source = readFileSync(filePath, "utf8");
    if (BUNDLED_PLUGIN_FACADE_LOADER_PATTERN.test(source)) {
      entrypoints.push(entrypoint);
    }
  }
  return entrypoints.toSorted();
}

function collectPrivateBundledSdkSurfaceEntrypoints(): string[] {
  const entrypoints: string[] = [];
  for (const entrypoint of pluginSdkEntrypoints) {
    const filePath = resolve(REPO_ROOT, "src/plugin-sdk", `${entrypoint}.ts`);
    const source = readFileSync(filePath, "utf8");
    if (PRIVATE_BUNDLED_SDK_SURFACE_PATTERN.test(source)) {
      entrypoints.push(entrypoint);
    }
  }
  return entrypoints.toSorted();
}

function collectGenericCoreOwnerNameLeaks(): Array<{ file: string; match: string }> {
  const leaks: Array<{ file: string; match: string }> = [];
  for (const file of GENERIC_CORE_HELPER_FILES) {
    const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
    for (const match of source.matchAll(GENERIC_CORE_PLUGIN_OWNER_NAME_PATTERN)) {
      const ownerName = match[0];
      if (!ownerName) {
        continue;
      }
      leaks.push({ file, match: ownerName });
    }
  }
  return leaks;
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

function isExtensionTestOrSupportPath(repoRelativePath: string): boolean {
  return (
    /(?:^|\/)(?:__tests__|tests|test-support)(?:\/|$)/.test(repoRelativePath) ||
    /(?:^|\/)test-support\.[cm]?tsx?$/.test(repoRelativePath) ||
    /(?:^|\/)test-helpers\.[cm]?tsx?$/.test(repoRelativePath) ||
    /(?:^|\/)test-harness\.[cm]?tsx?$/.test(repoRelativePath) ||
    /\.test-support\.[cm]?tsx?$/.test(repoRelativePath) ||
    /\.test-helpers\.[cm]?tsx?$/.test(repoRelativePath) ||
    /\.test-harness\.[cm]?tsx?$/.test(repoRelativePath) ||
    /\.test\.[cm]?tsx?$/.test(repoRelativePath)
  );
}

function collectExtensionCoreImportLeaks(): Array<{ file: string; specifier: string }> {
  const leaks: Array<{ file: string; specifier: string }> = [];
  const importPattern = /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']((?:\.\.\/)+src\/[^"']+)["']/g;
  for (const file of collectExtensionFiles(resolve(REPO_ROOT, "extensions"))) {
    const repoRelativePath = relative(REPO_ROOT, file).replaceAll("\\", "/");
    if (isExtensionTestOrSupportPath(repoRelativePath)) {
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

function collectExtensionTestHelperImportLeaks(): Array<{ file: string; specifier: string }> {
  const leaks: Array<{ file: string; specifier: string }> = [];
  const importPatterns = [
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']((?:\.\.\/)+test\/helpers\/[^"']+)["']/g,
    /\bimport\s*\(\s*["']((?:\.\.\/)+test\/helpers\/[^"']+)["']\s*\)/g,
    /\bvi\.(?:mock|doMock)\s*\(\s*["']((?:\.\.\/)+test\/helpers\/[^"']+)["']/g,
  ];
  for (const file of collectExtensionFiles(resolve(REPO_ROOT, "extensions"))) {
    const repoRelativePath = relative(REPO_ROOT, file).replaceAll("\\", "/");
    if (isExtensionTestOrSupportPath(repoRelativePath)) {
      continue;
    }
    const source = readFileSync(file, "utf8");
    for (const importPattern of importPatterns) {
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        if (!specifier) {
          continue;
        }
        leaks.push({
          file: repoRelativePath,
          specifier,
        });
      }
    }
  }
  return leaks;
}

function collectDeprecatedExtensionSdkImports(): Array<{ file: string; specifier: string }> {
  const leaks: Array<{ file: string; specifier: string }> = [];
  const importPatterns = [
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*["'](openclaw\/plugin-sdk(?:\/[a-z0-9][a-z0-9-]*)?)["']/g,
    /\bimport\s*\(\s*["'](openclaw\/plugin-sdk(?:\/[a-z0-9][a-z0-9-]*)?)["']\s*\)/g,
    /\bvi\.(?:mock|doMock)\s*\(\s*["'](openclaw\/plugin-sdk(?:\/[a-z0-9][a-z0-9-]*)?)["']/g,
  ];
  for (const file of collectExtensionFiles(resolve(REPO_ROOT, "extensions"))) {
    const repoRelativePath = relative(REPO_ROOT, file).replaceAll("\\", "/");
    const source = readFileSync(file, "utf8");
    for (const importPattern of importPatterns) {
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        if (!specifier || !DEPRECATED_EXTENSION_SDK_SPECIFIERS.has(specifier)) {
          continue;
        }
        leaks.push({
          file: repoRelativePath,
          specifier,
        });
      }
    }
  }
  return leaks;
}

function collectCodeFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const nextPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectCodeFiles(nextPath));
      continue;
    }
    if (!entry.isFile() || !/\.(?:[cm]?ts|tsx|mts|cts)$/.test(entry.name)) {
      continue;
    }
    files.push(nextPath);
  }
  return files;
}

function collectDeprecatedTestBarrelImports(): Array<{ file: string; specifier: string }> {
  const leaks: Array<{ file: string; specifier: string }> = [];
  const importPatterns = [
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*["'](openclaw\/plugin-sdk\/(?:testing|test-utils))["']/g,
    /\bimport\s*\(\s*["'](openclaw\/plugin-sdk\/(?:testing|test-utils))["']\s*\)/g,
    /\bvi\.(?:mock|doMock)\s*\(\s*["'](openclaw\/plugin-sdk\/(?:testing|test-utils))["']/g,
  ];
  for (const root of ["src", "test", "extensions", "packages"]) {
    for (const file of collectCodeFiles(resolve(REPO_ROOT, root))) {
      const repoRelativePath = relative(REPO_ROOT, file).replaceAll("\\", "/");
      if (DEPRECATED_TEST_BARREL_ALLOWED_REFERENCE_FILES.has(repoRelativePath)) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      for (const importPattern of importPatterns) {
        for (const match of source.matchAll(importPattern)) {
          const specifier = match[1];
          if (!specifier || !DEPRECATED_TEST_BARREL_SPECIFIERS.has(specifier)) {
            continue;
          }
          leaks.push({
            file: repoRelativePath,
            specifier,
          });
        }
      }
    }
  }
  return leaks;
}

function collectDeprecatedPackageTestingBridgeDrift(): string[] {
  const source = readFileSync(
    resolve(REPO_ROOT, "packages/plugin-sdk/src/testing.ts"),
    "utf8",
  ).trim();
  return source === 'export * from "../../../src/plugin-sdk/testing.js";'
    ? []
    : ["packages/plugin-sdk/src/testing.ts"];
}

function parseTestApiNamedExports(source: string): string[] {
  const exports = new Set<string>();
  const declarationPattern =
    /\bexport\s+(?:const|function|class|async\s+function|type|interface)\s+([A-Za-z_$][\w$]*)/g;
  const exportListPattern = /\bexport\s*\{([^}]+)\}/g;

  for (const match of source.matchAll(declarationPattern)) {
    const exportName = match[1];
    if (exportName) {
      exports.add(exportName);
    }
  }

  for (const match of source.matchAll(exportListPattern)) {
    const exportList = match[1];
    if (!exportList) {
      continue;
    }
    for (const part of exportList.split(",")) {
      const item = part.trim().replace(/^type\s+/, "");
      const aliasMatch = /\bas\s+([A-Za-z_$][\w$]*)$/u.exec(item);
      const nameMatch = /^([A-Za-z_$][\w$]*)/u.exec(item);
      const exportName = aliasMatch?.[1] ?? nameMatch?.[1];
      if (exportName && exportName !== "default") {
        exports.add(exportName);
      }
    }
  }

  return [...exports].toSorted();
}

function collectWorkspaceCodeFiles(): string[] {
  const files: string[] = [];
  for (const root of ["src", "test", "extensions", "packages", "scripts"]) {
    const dir = resolve(REPO_ROOT, root);
    if (existsSync(dir)) {
      files.push(...collectCodeFiles(dir));
    }
  }
  return files;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectUnusedExtensionTestApiExports(): Array<{ file: string; exportName: string }> {
  const leaks: Array<{ file: string; exportName: string }> = [];
  const workspaceCodeFiles = collectWorkspaceCodeFiles();
  const testApiFiles = collectCodeFiles(resolve(REPO_ROOT, "extensions")).filter((file) =>
    file.endsWith("/test-api.ts"),
  );
  const testApiExports = new Map<string, string[]>();
  const exportNames = new Set<string>();

  for (const file of testApiFiles) {
    const source = readFileSync(file, "utf8");
    const namedExports = parseTestApiNamedExports(source);
    testApiExports.set(file, namedExports);
    for (const exportName of namedExports) {
      exportNames.add(exportName);
    }
  }

  if (exportNames.size === 0) {
    return [];
  }

  const identifierPattern = new RegExp(
    `\\b(${[...exportNames].map(escapeRegExp).join("|")})\\b`,
    "g",
  );
  const referenceCounts = new Map<string, number>();
  const selfReferenceCounts = new Map<string, Map<string, number>>();

  for (const file of workspaceCodeFiles) {
    const source = readFileSync(file, "utf8");
    const selfCounts = testApiExports.has(file) ? new Map<string, number>() : undefined;
    for (const match of source.matchAll(identifierPattern)) {
      const exportName = match[1];
      if (!exportName) {
        continue;
      }
      referenceCounts.set(exportName, (referenceCounts.get(exportName) ?? 0) + 1);
      if (selfCounts) {
        selfCounts.set(exportName, (selfCounts.get(exportName) ?? 0) + 1);
      }
    }
    if (selfCounts) {
      selfReferenceCounts.set(file, selfCounts);
    }
  }

  for (const [file, namedExports] of testApiExports) {
    const repoRelativePath = relative(REPO_ROOT, file).replaceAll("\\", "/");
    for (const exportName of namedExports) {
      const referenceCount =
        (referenceCounts.get(exportName) ?? 0) -
        (selfReferenceCounts.get(file)?.get(exportName) ?? 0);
      if (referenceCount === 0) {
        leaks.push({ file: repoRelativePath, exportName });
      }
    }
  }

  return leaks.toSorted(
    (a, b) => a.file.localeCompare(b.file) || a.exportName.localeCompare(b.exportName),
  );
}

function collectCrossOwnerReservedSdkImports(): Array<{
  file: string;
  specifier: string;
  owner?: string;
}> {
  const leaks: Array<{ file: string; specifier: string; owner?: string }> = [];
  const reserved = new Set<string>(reservedBundledPluginSdkEntrypoints);
  const importPattern =
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']openclaw\/plugin-sdk\/([a-z0-9][a-z0-9-]*)["']/g;

  for (const file of collectExtensionFiles(resolve(REPO_ROOT, "extensions"))) {
    const repoRelativePath = relative(REPO_ROOT, file).replaceAll("\\", "/");
    const pluginId = repoRelativePath.split("/")[1];
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const subpath = match[1];
      if (!subpath || !reserved.has(subpath)) {
        continue;
      }
      const owner = resolvePluginOwnerFromEntrypoint(subpath);
      if (owner === pluginId) {
        continue;
      }
      leaks.push({
        file: repoRelativePath,
        specifier: `openclaw/plugin-sdk/${subpath}`,
        owner,
      });
    }
  }
  return leaks;
}

function collectReservedSdkSubpathImports(): string[] {
  const imports = new Set<string>();
  const reserved = new Set<string>(reservedBundledPluginSdkEntrypoints);
  const importPatterns = [
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']openclaw\/plugin-sdk\/([a-z0-9][a-z0-9-]*)["']/g,
    /\bimport\s*\(\s*["']openclaw\/plugin-sdk\/([a-z0-9][a-z0-9-]*)["']\s*\)/g,
    /\bvi\.(?:mock|doMock)\s*\(\s*["']openclaw\/plugin-sdk\/([a-z0-9][a-z0-9-]*)["']/g,
  ];

  for (const root of ["src", "test", "extensions", "packages", "scripts"]) {
    for (const file of collectCodeFiles(resolve(REPO_ROOT, root))) {
      const source = readFileSync(file, "utf8");
      for (const importPattern of importPatterns) {
        for (const match of source.matchAll(importPattern)) {
          const subpath = match[1];
          if (subpath && reserved.has(subpath)) {
            imports.add(subpath);
          }
        }
      }
    }
  }

  return [...imports].toSorted();
}

function hasWildcardReexport(entrypoint: string): boolean {
  const source = readFileSync(resolve(REPO_ROOT, "src/plugin-sdk", `${entrypoint}.ts`), "utf8");
  return /^\s*export\s+(?:type\s+)?\*\s+from\s+["'][^"']+["']/mu.test(source);
}

function collectExtensionProductionSdkSubpathImports(subpaths: ReadonlySet<string>): string[] {
  const imports = new Set<string>();
  const importPatterns = [
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']openclaw\/plugin-sdk\/([a-z0-9][a-z0-9-]*)["']/g,
    /\bimport\s*\(\s*["']openclaw\/plugin-sdk\/([a-z0-9][a-z0-9-]*)["']\s*\)/g,
    /\bvi\.(?:mock|doMock)\s*\(\s*["']openclaw\/plugin-sdk\/([a-z0-9][a-z0-9-]*)["']/g,
  ];

  for (const file of collectExtensionFiles(resolve(REPO_ROOT, "extensions"))) {
    const repoRelativePath = relative(REPO_ROOT, file).replaceAll("\\", "/");
    if (isExtensionTestOrSupportPath(repoRelativePath)) {
      continue;
    }
    const source = readFileSync(file, "utf8");
    for (const importPattern of importPatterns) {
      for (const match of source.matchAll(importPattern)) {
        const subpath = match[1];
        if (subpath && subpaths.has(subpath)) {
          imports.add(`${repoRelativePath}: openclaw/plugin-sdk/${subpath}`);
        }
      }
    }
  }

  return [...imports].toSorted();
}

describe("plugin-sdk package contract guardrails", () => {
  it("keeps plugin-sdk entrypoint metadata unique", () => {
    const counts = new Map<string, number>();
    for (const entrypoint of pluginSdkEntrypoints) {
      counts.set(entrypoint, (counts.get(entrypoint) ?? 0) + 1);
    }
    const duplicates = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([entrypoint]) => entrypoint)
      .toSorted();

    expect(duplicates).toStrictEqual([]);
  });

  it("keeps package.json exports aligned with built plugin-sdk entrypoints", () => {
    expect(collectPluginSdkPackageExports()).toEqual([...publicPluginSdkEntrypoints].toSorted());
  });

  it("keeps bundled plugin SDK compatibility subpaths explicitly classified", () => {
    const entrypoints = new Set(pluginSdkEntrypoints);
    const reserved = new Set<string>(reservedBundledPluginSdkEntrypoints);
    const supported = new Set<string>(supportedBundledFacadeSdkEntrypoints);
    const localOnly = new Set<string>(privateLocalOnlyPluginSdkEntrypoints);
    const unknownReserved = [...reserved].filter((entrypoint) => !entrypoints.has(entrypoint));
    const unknownSupported = [...supported].filter((entrypoint) => !entrypoints.has(entrypoint));
    const unknownLocalOnly = [...localOnly].filter((entrypoint) => !entrypoints.has(entrypoint));
    const unclassifiedBundledFacades = collectBundledFacadeSdkEntrypoints().filter(
      (entrypoint) => !reserved.has(entrypoint) && !supported.has(entrypoint),
    );
    const unreservedPrivateSurfaces = collectPrivateBundledSdkSurfaceEntrypoints().filter(
      (entrypoint) => !reserved.has(entrypoint) && !localOnly.has(entrypoint),
    );

    expect({
      unknownReserved,
      unknownSupported,
      unknownLocalOnly,
      unclassifiedBundledFacades,
      unreservedPrivateSurfaces,
    }).toEqual({
      unknownReserved: [],
      unknownSupported: [],
      unknownLocalOnly: [],
      unclassifiedBundledFacades: [],
      unreservedPrivateSurfaces: [],
    });
  });

  it("keeps plugin-owned SDK subpaths explicitly classified and documented", () => {
    const entrypoints = new Set(pluginSdkEntrypoints);
    const reserved = new Set<string>(reservedBundledPluginSdkEntrypoints);
    const supported = new Set<string>(supportedBundledFacadeSdkEntrypoints);
    const publicOwned = new Set<string>(publicPluginOwnedSdkEntrypoints);
    const localOnly = new Set<string>(privateLocalOnlyPluginSdkEntrypoints);
    const documented = collectDocumentedSdkSubpaths();
    const pluginOwnedEntrypoints = collectPluginOwnedSdkEntrypoints();
    const classified = new Set([...reserved, ...supported, ...publicOwned, ...localOnly]);

    const unknownPublicOwned = [...publicOwned].filter(
      (entrypoint) => !entrypoints.has(entrypoint),
    );
    const classificationOverlaps = collectClassificationOverlaps({
      reserved: reservedBundledPluginSdkEntrypoints,
      supported: supportedBundledFacadeSdkEntrypoints,
      publicOwned: publicPluginOwnedSdkEntrypoints,
      localOnly: privateLocalOnlyPluginSdkEntrypoints,
    });
    const unclassifiedPluginOwned = pluginOwnedEntrypoints.filter(
      (entrypoint) => !classified.has(entrypoint),
    );
    const undocumentedPluginOwned = pluginOwnedEntrypoints.filter(
      (entrypoint) => !documented.has(entrypoint),
    );

    expect({
      unknownPublicOwned,
      classificationOverlaps,
      unclassifiedPluginOwned,
      undocumentedPluginOwned,
    }).toEqual({
      unknownPublicOwned: [],
      classificationOverlaps: [],
      unclassifiedPluginOwned: [],
      undocumentedPluginOwned: [],
    });
  });

  it("keeps curated public plugin-sdk references on exported built subpaths", () => {
    const entrypoints = new Set(pluginSdkEntrypoints);
    const exports = new Set(collectPluginSdkPackageExports());
    const localOnly = new Set(privateLocalOnlyPluginSdkEntrypoints);
    const failures: string[] = [];

    for (const reference of collectPluginSdkSubpathReferences()) {
      const missingFrom: string[] = [];
      if (!entrypoints.has(reference.subpath)) {
        missingFrom.push("scripts/lib/plugin-sdk-entrypoints.json");
      }
      if (!exports.has(reference.subpath) && !localOnly.has(reference.subpath)) {
        missingFrom.push("package.json exports");
      }
      if (missingFrom.length === 0) {
        continue;
      }
      failures.push(
        `${reference.file} references openclaw/plugin-sdk/${reference.subpath}, but ${reference.subpath} is missing from ${missingFrom.join(" and ")}`,
      );
    }

    expect(failures).toStrictEqual([]);
  });

  it("keeps deprecated public SDK subpaths unused by extension production code", () => {
    const publicEntrypoints = new Set(publicPluginSdkEntrypoints);
    const unknownDeprecated = deprecatedPublicPluginSdkEntrypoints.filter(
      (entrypoint) => !publicEntrypoints.has(entrypoint),
    );
    const extensionImports = collectExtensionProductionSdkSubpathImports(
      new Set<string>(deprecatedPublicPluginSdkEntrypoints),
    );

    expect({ unknownDeprecated, extensionImports }).toEqual({
      unknownDeprecated: [],
      extensionImports: [],
    });
  });

  it("keeps deprecated SDK barrels explicit and buildable", () => {
    const entrypoints = new Set(pluginSdkEntrypoints);
    const unknownDeprecatedBarrels = deprecatedBarrelPluginSdkEntrypoints.filter(
      (entrypoint) => !entrypoints.has(entrypoint),
    );
    const nonBarrels = deprecatedBarrelPluginSdkEntrypoints.filter(
      (entrypoint) => !hasWildcardReexport(entrypoint),
    );

    expect({ unknownDeprecatedBarrels, nonBarrels }).toEqual({
      unknownDeprecatedBarrels: [],
      nonBarrels: [],
    });
  });

  it("keeps Matrix dependencies local to the Matrix plugin", () => {
    const rootRuntimeDeps = collectRuntimeDependencySpecs(readRootPackageJson());
    const matrixPackageJson = readMatrixPackageJson();
    const matrixRuntimeDeps = collectRuntimeDependencySpecs(matrixPackageJson);

    for (const dep of [
      "@matrix-org/matrix-sdk-crypto-wasm",
      "@matrix-org/matrix-sdk-crypto-nodejs",
      "fake-indexeddb",
      "matrix-js-sdk",
    ]) {
      expect(matrixRuntimeDeps.get(dep)).toBeTypeOf("string");
      expect(matrixRuntimeDeps.get(dep)).not.toBe("");
      expect(rootRuntimeDeps.has(dep)).toBe(false);
    }
    expect(rootRuntimeDeps.has("@openclaw/plugin-package-contract")).toBe(false);
  });

  it("keeps extension sources on public sdk or local package seams", () => {
    expect(collectExtensionCoreImportLeaks()).toStrictEqual([]);
  });

  it("keeps extension production sources off repo test helpers", () => {
    expect(collectExtensionTestHelperImportLeaks()).toStrictEqual([]);
  });

  it("keeps extension sources off deprecated plugin-sdk compatibility imports", () => {
    expect(collectDeprecatedExtensionSdkImports()).toStrictEqual([]);
  });

  it("keeps real tests off deprecated plugin-sdk testing barrels", () => {
    expect(collectDeprecatedTestBarrelImports()).toStrictEqual([]);
  });

  it("keeps the package testing barrel as a single deprecated bridge", () => {
    expect(collectDeprecatedPackageTestingBridgeDrift()).toStrictEqual([]);
  });

  it(
    "keeps extension test-api exports consumed",
    () => {
      expect(collectUnusedExtensionTestApiExports()).toStrictEqual([]);
    },
    PACKAGE_CONTRACT_SCAN_TIMEOUT_MS,
  );

  it("keeps reserved SDK compatibility subpaths inside their owning bundled plugins", () => {
    expect(collectCrossOwnerReservedSdkImports()).toStrictEqual([]);
  });

  it("keeps reserved SDK compatibility subpaths actively used", () => {
    const usedReserved = new Set(collectReservedSdkSubpathImports());
    const unusedReserved = reservedBundledPluginSdkEntrypoints.filter(
      (entrypoint) => !usedReserved.has(entrypoint),
    );

    expect(unusedReserved).toStrictEqual([]);
  });

  it("keeps generic core poll helpers free of plugin owner names", () => {
    expect(collectGenericCoreOwnerNameLeaks()).toStrictEqual([]);
  });
});
