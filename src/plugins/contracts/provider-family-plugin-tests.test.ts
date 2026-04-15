import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

function toRepoRelative(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

function listFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
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

  return files;
}

function listBundledPluginRoots() {
  return loadPluginManifestRegistry({})
    .plugins.filter((plugin) => plugin.origin === "bundled")
    .map((plugin) => ({
      pluginId: plugin.id,
      rootDir: plugin.workspaceDir ?? plugin.rootDir,
    }))
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
}

function collectSharedFamilyProviders(): Map<string, SharedFamilyProviderInventory> {
  const inventory = new Map<string, SharedFamilyProviderInventory>();

  for (const plugin of listBundledPluginRoots()) {
    for (const filePath of listFiles(plugin.rootDir)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".test.ts")) {
        continue;
      }
      const source = readFileSync(filePath, "utf8");
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
      const source = readFileSync(filePath, "utf8");
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
  const replayPattern = /buildProviderReplayFamilyHooks\s*\(\s*\{\s*family:\s*"([^"]+)"/gu;
  const streamPattern = /buildProviderStreamFamilyHooks\s*\(\s*"([^"]+)"/gu;
  const toolCompatPattern = /buildProviderToolCompatFamilyHooks\s*\(\s*"([^"]+)"/gu;

  for (const plugin of listBundledPluginRoots()) {
    for (const filePath of listFiles(plugin.rootDir)) {
      if (!filePath.endsWith(".ts") || filePath.endsWith(".test.ts")) {
        continue;
      }
      const source = readFileSync(filePath, "utf8");
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
  it("keeps shared-family provider hooks covered by at least one plugin-boundary test", () => {
    const sharedFamilyProviders = collectSharedFamilyProviders();
    const providerBoundaryTests = collectProviderBoundaryTests();

    const missing = [...sharedFamilyProviders.entries()]
      .filter(([pluginId]) => !providerBoundaryTests.has(pluginId))
      .map(([pluginId, inventory]) => {
        const hookKinds = [...inventory.hookKinds].toSorted().join(", ");
        const sourceFiles = [...inventory.sourceFiles].toSorted().join(", ");
        return `${pluginId} declares shared ${hookKinds} hooks but has no plugin-boundary provider test. Sources: ${sourceFiles}`;
      });

    expect(missing).toEqual([]);
  });

  it("keeps sentinel shared-family assignments wired through bundled provider sources", () => {
    const actualAssignments = Object.fromEntries(
      [...collectSharedFamilyAssignments().entries()].toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
    );

    for (const [pluginId, expected] of Object.entries(
      EXPECTED_SENTINEL_SHARED_FAMILY_ASSIGNMENTS,
    )) {
      expect(actualAssignments[pluginId]).toBeDefined();
      if (expected.replayFamilies) {
        expect(actualAssignments[pluginId]?.replayFamilies ?? []).toEqual(
          expect.arrayContaining([...expected.replayFamilies]),
        );
      }
      if (expected.streamFamilies) {
        expect(actualAssignments[pluginId]?.streamFamilies ?? []).toEqual(
          expect.arrayContaining([...expected.streamFamilies]),
        );
      }
      if (expected.toolCompatFamilies) {
        expect(actualAssignments[pluginId]?.toolCompatFamilies ?? []).toEqual(
          expect.arrayContaining([...expected.toolCompatFamilies]),
        );
      }
    }
  });
});
