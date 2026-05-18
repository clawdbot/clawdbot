import fs from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../../test-utils/repo-files.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";

type SharedFamilyHookKind = "replay" | "stream" | "tool-compat";

type SharedFamilyProviderInventory = {
  hookKinds: Set<SharedFamilyHookKind>;
  sourceFiles: Set<string>;
};

type ExpectedSharedFamilyContract = {
  replayFamilies?: readonly string[];
  streamFamilies?: readonly string[];
  toolCompatFamilies?: readonly string[];
};

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");
const SHARED_FAMILY_HOOK_PATTERNS: ReadonlyArray<{
  kind: SharedFamilyHookKind;
  regex: RegExp;
}> = [
  { kind: "replay", regex: /\bbuildProviderReplayFamilyHooks\s*\(/u },
  { kind: "stream", regex: /\bbuildProviderStreamFamilyHooks\s*\(/u },
  { kind: "tool-compat", regex: /\bbuildProviderToolCompatFamilyHooks\s*\(/u },
];
const PROVIDER_BOUNDARY_TEST_SIGNALS = [
  /\bregister(?:Single)?ProviderPlugin\s*\(/u,
  /\bcreateTestPluginApi\s*\(/u,
  /\bexpectPassthroughReplayPolicy\s*\(/u,
] as const;
const EXPECTED_SENTINEL_SHARED_FAMILY_ASSIGNMENTS: Record<string, ExpectedSharedFamilyContract> = {
  google: {
    replayFamilies: ["google-gemini"],
    toolCompatFamilies: ["gemini"],
  },
  minimax: {
    replayFamilies: ["hybrid-anthropic-openai"],
  },
  openai: {
    toolCompatFamilies: ["openai"],
  },
};
let bundledPluginRootsCache:
  | Array<{
      pluginId: string;
      rootDir: string;
    }>
  | undefined;
const filesByDirCache = new Map<string, string[]>();

function toRepoRelative(path: string): string {
  return toRepoRelativePath(REPO_ROOT, path);
}

function shouldSkipScannedPath(relativePath: string): boolean {
  return relativePath.split("/").some((part) => part === "dist" || part === "node_modules");
}

function listGitFiles(dir: string): string[] | null {
  const relativeDir = toRepoRelative(dir);
  if (!relativeDir || relativeDir.startsWith("..")) {
    return null;
  }
  const files = listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: relativeDir });
  if (!files) {
    return null;
  }
  return files
    .filter((line) => !shouldSkipScannedPath(line))
    .map((line) => resolve(REPO_ROOT, line))
    .filter((filePath) => fs.existsSync(filePath))
    .toSorted();
}

function listFiles(dir: string): string[] {
  const cached = filesByDirCache.get(dir);
  if (cached) {
    return cached;
  }
  const gitFiles = listGitFiles(dir);
  if (gitFiles) {
    filesByDirCache.set(dir, gitFiles);
    return gitFiles;
  }

  const files: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
      continue;
    }
    files.push(entryPath);
  }

  filesByDirCache.set(dir, files);
  return files;
}

function listBundledPluginRoots() {
  if (bundledPluginRootsCache) {
    return bundledPluginRootsCache;
  }
  bundledPluginRootsCache = loadPluginManifestRegistry({})
    .plugins.filter((plugin) => plugin.origin === "bundled")
    .map((plugin) => ({
      pluginId: plugin.id,
      rootDir: resolveBundledPluginSourceRoot(plugin.rootDir, plugin.workspaceDir),
    }))
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
  return bundledPluginRootsCache;
}

function resolveBundledPluginSourceRoot(rootDir: string, workspaceDir?: string): string {
  if (workspaceDir) {
    return workspaceDir;
  }
  const sourceRoot = resolve(REPO_ROOT, "extensions", basename(rootDir));
  return fs.existsSync(sourceRoot) ? sourceRoot : rootDir;
}

function collectSharedFamilyProviders(): Map<string, SharedFamilyProviderInventory> {
  const inventory = new Map<string, SharedFamilyProviderInventory>();

  for (const plugin of listBundledPluginRoots()) {
    for (const filePath of listFiles(plugin.rootDir)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".test.ts")) {
        continue;
      }
      const source = fs.readFileSync(filePath, "utf8");
      const matchedKinds = SHARED_FAMILY_HOOK_PATTERNS.filter(({ regex }) => regex.test(source));
      if (matchedKinds.length === 0) {
        continue;
      }
      const entry = inventory.get(plugin.pluginId) ?? {
        hookKinds: new Set<SharedFamilyHookKind>(),
        sourceFiles: new Set<string>(),
      };
      for (const { kind } of matchedKinds) {
        entry.hookKinds.add(kind);
      }
      entry.sourceFiles.add(toRepoRelative(filePath));
      inventory.set(plugin.pluginId, entry);
    }
  }

  return inventory;
}

function collectProviderBoundaryTests(): Map<string, Set<string>> {
  const inventory = new Map<string, Set<string>>();

  for (const plugin of listBundledPluginRoots()) {
    for (const filePath of listFiles(plugin.rootDir)) {
      if (!filePath.endsWith(".test.ts")) {
        continue;
      }
      const source = fs.readFileSync(filePath, "utf8");
      if (!PROVIDER_BOUNDARY_TEST_SIGNALS.some((signal) => signal.test(source))) {
        continue;
      }
      const tests = inventory.get(plugin.pluginId) ?? new Set<string>();
      tests.add(toRepoRelative(filePath));
      inventory.set(plugin.pluginId, tests);
    }
  }

  return inventory;
}

function listMatchingFamilies(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1] ?? "");
}

function collectSharedFamilyAssignments(): Map<string, ExpectedSharedFamilyContract> {
  const inventory = new Map<string, ExpectedSharedFamilyContract>();
  const replayPattern = /buildProviderReplayFamilyHooks\s*\(\s*\{[\s\S]*?\bfamily:\s*"([^"]+)"/gu;
  const streamPattern = /buildProviderStreamFamilyHooks\s*\(\s*"([^"]+)"/gu;
  const toolCompatPattern = /buildProviderToolCompatFamilyHooks\s*\(\s*"([^"]+)"/gu;

  for (const plugin of listBundledPluginRoots()) {
    for (const filePath of listFiles(plugin.rootDir)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".test.ts")) {
        continue;
      }
      const source = fs.readFileSync(filePath, "utf8");
      const replayFamilies = listMatchingFamilies(source, replayPattern);
      const streamFamilies = listMatchingFamilies(source, streamPattern);
      const toolCompatFamilies = listMatchingFamilies(source, toolCompatPattern);
      if (
        replayFamilies.length === 0 &&
        streamFamilies.length === 0 &&
        toolCompatFamilies.length === 0
      ) {
        continue;
      }
      const entry = inventory.get(plugin.pluginId) ?? {};
      if (replayFamilies.length > 0) {
        entry.replayFamilies = [
          ...new Set([...(entry.replayFamilies ?? []), ...replayFamilies]),
        ].toSorted();
      }
      if (streamFamilies.length > 0) {
        entry.streamFamilies = [
          ...new Set([...(entry.streamFamilies ?? []), ...streamFamilies]),
        ].toSorted();
      }
      if (toolCompatFamilies.length > 0) {
        entry.toolCompatFamilies = [
          ...new Set([...(entry.toolCompatFamilies ?? []), ...toolCompatFamilies]),
        ].toSorted();
      }
      inventory.set(plugin.pluginId, entry);
    }
  }

  return inventory;
}

describe("provider family plugin-boundary inventory", () => {
  let bundledRoots: ReturnType<typeof listBundledPluginRoots>;
  let sharedFamilyProviders: ReturnType<typeof collectSharedFamilyProviders>;
  let providerBoundaryTests: ReturnType<typeof collectProviderBoundaryTests>;
  let actualAssignments: Record<string, ExpectedSharedFamilyContract>;

  beforeAll(() => {
    bundledRoots = listBundledPluginRoots();
    for (const plugin of bundledRoots) {
      listFiles(plugin.rootDir);
    }
    sharedFamilyProviders = collectSharedFamilyProviders();
    providerBoundaryTests = collectProviderBoundaryTests();
    actualAssignments = Object.fromEntries(
      [...collectSharedFamilyAssignments().entries()].toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  });

  it("lists bundled plugin files from git without walking plugin roots", () => {
    filesByDirCache.clear();
    expectNoReaddirSyncDuring(() => {
      const files = bundledRoots.flatMap((plugin) => listFiles(plugin.rootDir));

      expect(files.length).toBeGreaterThan(0);
      expect(files.some((file) => toRepoRelative(file).startsWith("extensions/"))).toBe(true);
    });
  });

  it("keeps shared-family provider hooks covered by at least one plugin-boundary test", () => {
    const missing = [...sharedFamilyProviders.entries()]
      .filter(([pluginId]) => !providerBoundaryTests.has(pluginId))
      .map(([pluginId, inventory]) => {
        const hookKinds = [...inventory.hookKinds].toSorted().join(", ");
        const sourceFiles = [...inventory.sourceFiles].toSorted().join(", ");
        return `${pluginId} declares shared ${hookKinds} hooks but has no plugin-boundary provider test. Sources: ${sourceFiles}`;
      });

    expect(missing).toStrictEqual([]);
  });

  it("keeps sentinel shared-family assignments wired through bundled provider sources", () => {
    for (const [pluginId, expected] of Object.entries(
      EXPECTED_SENTINEL_SHARED_FAMILY_ASSIGNMENTS,
    )) {
      if (actualAssignments[pluginId] === undefined) {
        throw new Error(`missing shared provider-family assignment for ${pluginId}`);
      }
      expect(actualAssignments[pluginId]).toEqual(expected);
    }
  });
});
