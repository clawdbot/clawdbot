// Plugin SDK package guardrail tests cover package export and contract drift checks.
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRealtimeTranscriptionWebSocketSession,
  type RealtimeTranscriptionSessionCallbacks,
} from "openclaw/plugin-sdk/realtime-transcription";
import { beforeAll, describe, expect, it } from "vitest";
import {
  deprecatedBarrelPluginSdkEntrypoints,
  deprecatedPublicPluginSdkEntrypoints,
  packagedPrivatePluginSdkRuntimeEntrypoints,
  privateLocalOnlyPluginSdkEntrypoints,
  pluginSdkEntrypoints,
  publicPluginOwnedSdkEntrypoints,
  publicPluginSdkEntrypoints,
  supportedBundledFacadeSdkEntrypoints,
} from "../../../scripts/lib/plugin-sdk-entries.mts";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import {
  listGitTrackedFiles,
  toRepoPath,
  toRepoRelativePath as toRepoRelativePathFromRoot,
} from "../../test-utils/repo-files.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(ROOT_DIR, "..");
const SDK_SUBPATH_DOC_FILE = "docs/plugins/sdk-subpaths.md";
const PUBLIC_CONTRACT_REFERENCE_FILES = [
  "docs/plugins/architecture.md",
  "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
] as const;
const TYPED_PUBLIC_CONTRACT_REFERENCE_FILES = ["docs/plugins/sdk-entrypoints.md"] as const;
const PLUGIN_SDK_SUBPATH_PATTERN = /openclaw\/plugin-sdk\/([a-z0-9][a-z0-9-]*)\b/g;
const BUNDLED_PLUGIN_FACADE_LOADER_PATTERN =
  /\bload(?:Activated)?BundledPluginPublicSurfaceModuleSync\b/;
const PRIVATE_BUNDLED_SDK_SURFACE_PATTERN =
  /\b(?:Private helper surface|Narrow plugin-sdk surface for the bundled|Narrow .*runtime exports used by the bundled)\b/i;
const GENERIC_CORE_HELPER_FILES = ["src/polls.ts", "src/poll-params.ts"] as const;
const GENERIC_CORE_PLUGIN_OWNER_NAME_PATTERN =
  /\b(?:imessage|discord|feishu|googlechat|matrix|mattermost|msteams|slack|telegram|whatsapp|zalo|zalouser)\b/gi;
const DEPRECATED_EXTENSION_SDK_SPECIFIERS = new Set([
  "openclaw/plugin-sdk",
  // Bundled code uses the canonical channel-config-schema subpath; the
  // primitives/legacy shells stay export-compatible for third parties only.
  "openclaw/plugin-sdk/channel-config-primitives",
  "openclaw/plugin-sdk/channel-config-schema-legacy",
  "openclaw/plugin-sdk/compat",
  "openclaw/plugin-sdk/test-utils",
]);
const DEPRECATED_TEST_ALIAS_SPECIFIERS = new Set(["openclaw/plugin-sdk/test-utils"]);
const DEPRECATED_TEST_ALIAS_ALLOWED_REFERENCE_FILES = new Set([
  "src/plugins/compat/registry.ts",
  "src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts",
]);
const MATRIX_RUNTIME_DEPS = [
  "@matrix-org/matrix-sdk-crypto-wasm",
  "@matrix-org/matrix-sdk-crypto-nodejs",
  "fake-indexeddb",
  "matrix-js-sdk",
  "music-metadata",
] as const;
const trackedFilesByRoot = new Map<string, readonly string[] | null>();

function toRepoRelativePath(filePath: string): string {
  return toRepoRelativePathFromRoot(REPO_ROOT, filePath);
}

function isSkippedTrackedPath(repoRelativePath: string): boolean {
  return repoRelativePath
    .split("/")
    .some((part) => part === "dist" || part === "node_modules" || part === ".git");
}

function isCodeFile(filePath: string): boolean {
  return /\.(?:[cm]?ts|tsx|mts|cts)$/.test(filePath);
}

function listTrackedFiles(root: string): string[] | null {
  const relativeRoot = toRepoRelativePath(root);
  if (!relativeRoot || relativeRoot.startsWith("..")) {
    return null;
  }
  if (trackedFilesByRoot.has(relativeRoot)) {
    const files = trackedFilesByRoot.get(relativeRoot);
    return files ? [...files] : null;
  }
  const trackedFiles = listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: relativeRoot });
  if (!trackedFiles) {
    trackedFilesByRoot.set(relativeRoot, null);
    return null;
  }
  const files = trackedFiles
    .filter((line) => line.length > 0 && !isSkippedTrackedPath(line))
    .map((line) => resolve(REPO_ROOT, line))
    .filter((filePath) => fs.existsSync(filePath))
    .toSorted();
  trackedFilesByRoot.set(relativeRoot, files);
  return [...files];
}

function listTrackedCodeFiles(root: string): string[] | null {
  const files = listTrackedFiles(root);
  return files?.filter(isCodeFile) ?? null;
}

function collectPluginSdkPackageExports(): string[] {
  const packageJson = JSON.parse(fs.readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
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

function collectTypedPluginSdkPackageExports(): Set<string> {
  const packageJson = JSON.parse(fs.readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
  };
  const typedSubpaths = new Set<string>();
  for (const [key, value] of Object.entries(packageJson.exports ?? {})) {
    if (
      key.startsWith("./plugin-sdk/") &&
      value &&
      typeof value === "object" &&
      "types" in value &&
      typeof value.types === "string"
    ) {
      typedSubpaths.add(key.slice("./plugin-sdk/".length));
    }
  }
  return typedSubpaths;
}

function collectPackExcludedPluginSdkDeclarations(): Set<string> {
  const packageJson = readRootPackageJson();
  return new Set(
    (packageJson.files ?? [])
      .map((entry) => /^!dist\/plugin-sdk\/([a-z0-9][a-z0-9-]*)\.d\.ts$/u.exec(entry)?.[1])
      .filter((subpath): subpath is string => Boolean(subpath)),
  );
}

function collectPluginSdkSubpathReferences(
  files: readonly string[] = PUBLIC_CONTRACT_REFERENCE_FILES,
) {
  const references: Array<{ file: string; subpath: string }> = [];
  for (const file of files) {
    const source = fs.readFileSync(resolve(REPO_ROOT, file), "utf8");
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
  const source = fs.readFileSync(resolve(REPO_ROOT, SDK_SUBPATH_DOC_FILE), "utf8");
  return new Set(
    [...source.matchAll(/`plugin-sdk\/([a-z0-9][a-z0-9-]*)`/g)]
      .map((match) => match[1])
      .filter((subpath): subpath is string => Boolean(subpath)),
  );
}

function collectBundledPluginIds(): string[] {
  const trackedFiles = listTrackedFiles(resolve(REPO_ROOT, "extensions"));
  if (trackedFiles) {
    return [
      ...new Set(
        trackedFiles
          .map((file) => toRepoRelativePath(file).split("/"))
          .filter((parts) => parts.length > 2)
          .map((parts) => parts[1])
          .filter((pluginId): pluginId is string => Boolean(pluginId)),
      ),
    ].toSorted((a, b) => b.length - a.length || a.localeCompare(b));
  }
  return fs
    .readdirSync(resolve(REPO_ROOT, "extensions"), { withFileTypes: true })
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
    const source = fs.readFileSync(filePath, "utf8");
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
    const source = fs.readFileSync(filePath, "utf8");
    if (PRIVATE_BUNDLED_SDK_SURFACE_PATTERN.test(source)) {
      entrypoints.push(entrypoint);
    }
  }
  return entrypoints.toSorted();
}

function collectGenericCoreOwnerNameLeaks(): Array<{ file: string; match: string }> {
  const leaks: Array<{ file: string; match: string }> = [];
  for (const file of GENERIC_CORE_HELPER_FILES) {
    const source = fs.readFileSync(resolve(REPO_ROOT, file), "utf8");
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
  files?: string[];
} {
  return JSON.parse(fs.readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    files?: string[];
  };
}

function readMatrixPackageJson(): {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
} {
  return JSON.parse(
    fs.readFileSync(resolve(REPO_ROOT, "extensions/matrix/package.json"), "utf8"),
  ) as {
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
  const trackedFiles = listTrackedCodeFiles(dir);
  if (trackedFiles) {
    return trackedFiles;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
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
    /(?:^|\/)test-runtime\.[cm]?tsx?$/.test(repoRelativePath) ||
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
    const repoRelativePath = toRepoRelativePath(file);
    if (isExtensionTestOrSupportPath(repoRelativePath)) {
      continue;
    }
    const extensionRootMatch = /^(.*?\/extensions\/[^/]+)/.exec(toRepoPath(file));
    const extensionRoot = extensionRootMatch?.[1];
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier) {
        continue;
      }
      const resolvedSpecifier = toRepoPath(resolve(dirname(file), specifier));
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
    const repoRelativePath = toRepoRelativePath(file);
    if (isExtensionTestOrSupportPath(repoRelativePath)) {
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
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
    const repoRelativePath = toRepoRelativePath(file);
    const source = fs.readFileSync(file, "utf8");
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
  const trackedFiles = listTrackedCodeFiles(dir);
  if (trackedFiles) {
    return trackedFiles;
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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

function collectDeprecatedTestAliasImports(): string[] {
  const leaks: Array<{ file: string; specifier: string }> = [];
  const importPatterns = [
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*["'](openclaw\/plugin-sdk\/test-utils)["']/g,
    /\bimport\s*\(\s*["'](openclaw\/plugin-sdk\/test-utils)["']\s*\)/g,
    /\bvi\.(?:mock|doMock)\s*\(\s*["'](openclaw\/plugin-sdk\/test-utils)["']/g,
  ];
  for (const root of ["src", "test", "extensions", "packages"]) {
    for (const file of collectCodeFiles(resolve(REPO_ROOT, root))) {
      const repoRelativePath = toRepoRelativePath(file);
      if (DEPRECATED_TEST_ALIAS_ALLOWED_REFERENCE_FILES.has(repoRelativePath)) {
        continue;
      }
      const source = fs.readFileSync(file, "utf8");
      for (const importPattern of importPatterns) {
        for (const match of source.matchAll(importPattern)) {
          const specifier = match[1];
          if (!specifier || !DEPRECATED_TEST_ALIAS_SPECIFIERS.has(specifier)) {
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
  return leaks.map((entry) => `${entry.file}: ${entry.specifier}`).toSorted();
}

function collectWorkspaceCodeFiles(): string[] {
  const files: string[] = [];
  for (const root of ["src", "test", "extensions", "packages", "scripts"]) {
    const dir = resolve(REPO_ROOT, root);
    if (fs.existsSync(dir)) {
      files.push(...collectCodeFiles(dir));
    }
  }
  return files;
}

function hasWildcardReexport(entrypoint: string): boolean {
  const source = fs.readFileSync(resolve(REPO_ROOT, "src/plugin-sdk", `${entrypoint}.ts`), "utf8");
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
    const repoRelativePath = toRepoRelativePath(file);
    if (isExtensionTestOrSupportPath(repoRelativePath)) {
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
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
  let deprecatedTestAliasImports: string[] = [];

  beforeAll(() => {
    deprecatedTestAliasImports = collectDeprecatedTestAliasImports();
  });

  it("lists package guardrail scan inputs from git without walking roots", () => {
    expectNoReaddirSyncDuring(() => {
      const pluginIds = collectBundledPluginIds();
      const extensionFiles = collectExtensionFiles(resolve(REPO_ROOT, "extensions"));
      const workspaceFiles = collectWorkspaceCodeFiles();

      expect(pluginIds.length).toBeGreaterThan(0);
      expect(extensionFiles.length).toBeGreaterThan(0);
      expect(workspaceFiles.length).toBeGreaterThan(extensionFiles.length);
    });
  });

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
    const packageExports = collectPluginSdkPackageExports();
    const typedPackageExports = collectTypedPluginSdkPackageExports();

    expect(packageExports).toEqual(
      [...publicPluginSdkEntrypoints, ...packagedPrivatePluginSdkRuntimeEntrypoints].toSorted(),
    );
    expect([...typedPackageExports].toSorted()).toEqual([...publicPluginSdkEntrypoints].toSorted());
  });

  it("keeps Vitest-backed SDK test helpers local-only", () => {
    const localOnly = new Set(privateLocalOnlyPluginSdkEntrypoints);

    expect(
      ["plugin-test-contracts", "provider-test-contracts"].every((entrypoint) =>
        localOnly.has(entrypoint),
      ),
    ).toBe(true);
  });

  it("keeps configured local-origin fetch helpers out of deprecated infra-runtime", () => {
    const source = fs.readFileSync(resolve(REPO_ROOT, "src/plugin-sdk/infra-runtime.ts"), "utf8");

    expect(source).not.toMatch(/export\s+\*\s+from\s+["']\.\.\/infra\/net\/fetch-guard\.js["']/);
    expect(source).not.toContain("fetchConfiguredLocalOriginWithSsrFGuard");
    expect(source).not.toContain("GuardedFetchConfiguredLocalOriginOptions");
  });

  it("keeps configured local-origin fetch helpers out of the public SSRF runtime", async () => {
    const ssrfRuntime = await import("../../plugin-sdk/ssrf-runtime.js");

    expect(ssrfRuntime).not.toHaveProperty("fetchConfiguredLocalOriginWithSsrFGuard");
  });

  it("keeps memory provenance mutation out of the packaged Memory Core facade", async () => {
    const memoryCoreRuntime = await import("../../plugin-sdk/memory-core-host-runtime-core.js");

    expect(memoryCoreRuntime).not.toHaveProperty("recordMemoryArtifactWriteProvenance");
  });

  it("keeps bundled plugin SDK compatibility subpaths explicitly classified", () => {
    const entrypoints = new Set(pluginSdkEntrypoints);
    const supported = new Set<string>(supportedBundledFacadeSdkEntrypoints);
    const localOnly = new Set<string>(privateLocalOnlyPluginSdkEntrypoints);
    const unknownSupported = [...supported].filter((entrypoint) => !entrypoints.has(entrypoint));
    const unknownLocalOnly = [...localOnly].filter((entrypoint) => !entrypoints.has(entrypoint));
    const unclassifiedBundledFacades = collectBundledFacadeSdkEntrypoints().filter(
      (entrypoint) => !supported.has(entrypoint) && !localOnly.has(entrypoint),
    );
    const unclassifiedPrivateSurfaces = collectPrivateBundledSdkSurfaceEntrypoints().filter(
      (entrypoint) => !localOnly.has(entrypoint),
    );

    expect({
      unknownSupported,
      unknownLocalOnly,
      unclassifiedBundledFacades,
      unclassifiedPrivateSurfaces,
    }).toEqual({
      unknownSupported: [],
      unknownLocalOnly: [],
      unclassifiedBundledFacades: [],
      unclassifiedPrivateSurfaces: [],
    });
  });

  it("keeps plugin-owned SDK subpaths explicitly classified and documented", () => {
    const entrypoints = new Set(pluginSdkEntrypoints);
    const supported = new Set<string>(supportedBundledFacadeSdkEntrypoints);
    const publicOwned = new Set<string>(publicPluginOwnedSdkEntrypoints);
    const localOnly = new Set<string>(privateLocalOnlyPluginSdkEntrypoints);
    const documented = collectDocumentedSdkSubpaths();
    const pluginOwnedEntrypoints = collectPluginOwnedSdkEntrypoints();
    const classified = new Set([...supported, ...publicOwned, ...localOnly]);

    const unknownPublicOwned = [...publicOwned].filter(
      (entrypoint) => !entrypoints.has(entrypoint),
    );
    const classificationOverlaps = collectClassificationOverlaps({
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

  it("keeps SDK entrypoint guide imports on typed public package exports", () => {
    const publicEntrypoints = new Set(publicPluginSdkEntrypoints);
    const typedExports = collectTypedPluginSdkPackageExports();
    const excludedDeclarations = collectPackExcludedPluginSdkDeclarations();
    const failures = collectPluginSdkSubpathReferences(TYPED_PUBLIC_CONTRACT_REFERENCE_FILES)
      .filter(
        ({ subpath }) =>
          !publicEntrypoints.has(subpath) ||
          !typedExports.has(subpath) ||
          excludedDeclarations.has(subpath),
      )
      .map(
        ({ file, subpath }) =>
          `${file} references openclaw/plugin-sdk/${subpath}, but its declaration is not included in the typed public package`,
      );

    expect(failures).toStrictEqual([]);
  });

  it("ships realtime transcription as a typed public SDK subpath", () => {
    const subpath = "realtime-transcription";

    expect({
      public: publicPluginSdkEntrypoints.includes(subpath),
      typed: collectTypedPluginSdkPackageExports().has(subpath),
      packExcluded: collectPackExcludedPluginSdkDeclarations().has(subpath),
    }).toEqual({
      public: true,
      typed: true,
      packExcluded: false,
    });
  });

  it("keeps the documented realtime transcription consumer type-safe", () => {
    type AcmeRealtimeEvent = { type: string; text?: string };
    const parseAcmeRealtimeEvent = (payload: Buffer): AcmeRealtimeEvent => {
      const value = JSON.parse(payload.toString()) as unknown;
      if (!value || typeof value !== "object" || !("type" in value)) {
        throw new Error("Acme realtime event must be an object with a type.");
      }
      const { type, text } = value as { type?: unknown; text?: unknown };
      if (typeof type !== "string" || (text !== undefined && typeof text !== "string")) {
        throw new Error("Acme realtime event has invalid fields.");
      }
      return { type, ...(text === undefined ? {} : { text }) };
    };

    const createConsumer = (callbacks: RealtimeTranscriptionSessionCallbacks) =>
      createRealtimeTranscriptionWebSocketSession<AcmeRealtimeEvent>({
        providerId: "acme-ai",
        callbacks,
        url: "wss://api.example.com/v1/realtime-transcription",
        parseMessage: parseAcmeRealtimeEvent,
        onMessage: (event, transport) => {
          if (event.type === "session.created") {
            transport.markReady();
            return;
          }
          if (event.type === "transcript.final" && typeof event.text === "string") {
            callbacks.onTranscript?.(event.text);
          }
        },
        sendAudio: () => {},
      });
    const docs = fs.readFileSync(
      resolve(REPO_ROOT, "docs/plugins/sdk-provider-plugins.md"),
      "utf8",
    );

    expect(typeof createConsumer).toBe("function");
    expect(docs).toContain("type AcmeRealtimeEvent =");
    expect(docs).toContain("parseMessage: parseAcmeRealtimeEvent");
  });

  it("keeps realtime transcription registry helpers on a private runtime subpath", () => {
    const publicSource = fs.readFileSync(
      resolve(REPO_ROOT, "src/plugin-sdk/realtime-transcription.ts"),
      "utf8",
    );
    const registryExports = [
      "canonicalizeRealtimeTranscriptionProviderId",
      "getRealtimeTranscriptionProvider",
      "listRealtimeTranscriptionProviders",
      "normalizeRealtimeTranscriptionProviderId",
    ];

    expect(registryExports.filter((name) => publicSource.includes(name))).toStrictEqual([]);
    expect(privateLocalOnlyPluginSdkEntrypoints).toContain("realtime-transcription-runtime");
    expect(publicPluginSdkEntrypoints).not.toContain("realtime-transcription-runtime");
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
    const rootPackageJson = readRootPackageJson();
    const rootRuntimeDeps = collectRuntimeDependencySpecs(rootPackageJson);
    const matrixPackageJson = readMatrixPackageJson();
    const matrixRuntimeDeps = collectRuntimeDependencySpecs(matrixPackageJson);

    expect(rootPackageJson.files).toContain("!dist/extensions/matrix/**");
    for (const dep of MATRIX_RUNTIME_DEPS) {
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

  it("keeps real tests off the deprecated plugin-sdk test-utils alias", () => {
    expect(deprecatedTestAliasImports).toStrictEqual([]);
  });

  it("keeps generic core poll helpers free of plugin owner names", () => {
    expect(collectGenericCoreOwnerNameLeaks()).toStrictEqual([]);
  });
});
