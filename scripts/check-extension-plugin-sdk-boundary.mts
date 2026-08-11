#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
// Inventories extension imports to enforce plugin SDK boundary rules.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  BUNDLED_PLUGIN_PATH_PREFIX,
  BUNDLED_PLUGIN_ROOT_DIR,
} from "./lib/bundled-plugin-paths.mjs";
import { createExtensionImportBoundaryChecker } from "./lib/extension-import-boundary-checker.mts";
import { classifyBundledExtensionSourcePath } from "./lib/extension-source-classifier.mts";
import {
  formatGroupedInventoryHuman,
  resolveRepoSpecifier,
  writeLine,
} from "./lib/guard-inventory-utils.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { listGeneratedExtensionAssetSources } from "./lib/static-extension-assets.mts";
import { runAsScript } from "./lib/ts-guard-utils.mts";

const repoRoot = resolveRepoRoot(import.meta.url);
type BoundaryMode = "src-outside-plugin-sdk" | "plugin-sdk-internal" | "relative-outside-package";
type ModuleReference = { kind: string; line: number; specifier: string };
type BoundaryEntry = ModuleReference & { file: string; resolvedPath: string; reason: string };
type CollectedBoundaryEntry = { mode: BoundaryMode; entry: BoundaryEntry };
type BoundaryInventoryByMode = Partial<Record<BoundaryMode, BoundaryEntry[]>>;
type BoundaryCheckIo = {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
};

// Generated bundles are validated at their build owner; they are not bounded authored source.
const generatedExtensionAssetSources = new Set(
  listGeneratedExtensionAssetSources({ rootDir: repoRoot }),
);

const MODES = new Set<BoundaryMode>([
  "src-outside-plugin-sdk",
  "plugin-sdk-internal",
  "relative-outside-package",
]);

const baselinePathByMode = {
  "src-outside-plugin-sdk": path.join(
    repoRoot,
    "test",
    "fixtures",
    "extension-src-outside-plugin-sdk-inventory.json",
  ),
  "plugin-sdk-internal": path.join(
    repoRoot,
    "test",
    "fixtures",
    "extension-plugin-sdk-internal-inventory.json",
  ),
} satisfies Partial<Record<BoundaryMode, string>>;
type BaselineBoundaryMode = keyof typeof baselinePathByMode;

let allInventoryByModePromise: Promise<BoundaryInventoryByMode> | undefined;
const ruleTextByMode: Record<BoundaryMode, string> = {
  "src-outside-plugin-sdk":
    "Rule: production bundled plugins must not import src/** outside src/plugin-sdk/**",
  "plugin-sdk-internal":
    "Rule: production bundled plugins must not import src/plugin-sdk-internal/**",
  "relative-outside-package":
    "Rule: production bundled plugins must not use relative imports that escape their own package root",
};

function classifyReason(mode: BoundaryMode, kind: string, resolved: string, specifier: string) {
  const verb =
    kind === "export"
      ? "re-exports"
      : kind === "dynamic-import"
        ? "dynamically imports"
        : "imports";
  if (mode === "relative-outside-package") {
    if (resolved.startsWith("src/plugin-sdk/")) {
      return `${verb} plugin-sdk via relative path; use openclaw/plugin-sdk/<subpath>`;
    }
    if (resolved.startsWith("src/")) {
      return `${verb} core src path via relative path outside the extension package`;
    }
    if (resolved.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
      return `${verb} another bundled plugin via relative path outside the extension package`;
    }
    return `${verb} relative path ${specifier} outside the extension package`;
  }
  if (mode === "plugin-sdk-internal") {
    return `${verb} src/plugin-sdk-internal from an extension`;
  }
  if (resolved.startsWith("src/plugin-sdk/")) {
    return `${verb} allowed plugin-sdk path`;
  }
  return `${verb} core src path outside plugin-sdk from an extension`;
}

function compareEntries(left: BoundaryEntry, right: BoundaryEntry): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier) ||
    left.resolvedPath.localeCompare(right.resolvedPath) ||
    left.reason.localeCompare(right.reason)
  );
}

function isBoundaryEntry(value: unknown): value is BoundaryEntry {
  return (
    isRecord(value) &&
    typeof value.file === "string" &&
    typeof value.line === "number" &&
    typeof value.kind === "string" &&
    typeof value.specifier === "string" &&
    typeof value.resolvedPath === "string" &&
    typeof value.reason === "string"
  );
}

function isBoundaryEntryArray(value: unknown): value is BoundaryEntry[] {
  return Array.isArray(value) && value.every(isBoundaryEntry);
}

const collectBoundaryEntries: NonNullable<
  Parameters<
    typeof createExtensionImportBoundaryChecker<CollectedBoundaryEntry>
  >[0]["collectEntries"]
> = ({ filePath, relativeFile, references }) => {
  const extensionRoot = relativeFile.split("/").slice(0, 2).join("/");
  const entries: CollectedBoundaryEntry[] = [];
  for (const { kind, line, specifier } of references) {
    const resolvedPath = resolveRepoSpecifier(repoRoot, specifier, filePath);
    if (!resolvedPath) {
      continue;
    }
    const modes: BoundaryMode[] = [];
    if (
      specifier.startsWith(".") &&
      resolvedPath !== extensionRoot &&
      !resolvedPath.startsWith(extensionRoot + "/")
    ) {
      modes.push("relative-outside-package");
    }
    if (resolvedPath.startsWith("src/") && !resolvedPath.startsWith("src/plugin-sdk/")) {
      modes.push("src-outside-plugin-sdk");
    }
    if (resolvedPath.startsWith("src/plugin-sdk-internal/")) {
      modes.push("plugin-sdk-internal");
    }
    for (const mode of modes) {
      entries.push({
        mode,
        entry: {
          file: relativeFile,
          line,
          kind,
          specifier,
          resolvedPath,
          reason: classifyReason(mode, kind, resolvedPath, specifier),
        },
      });
    }
  }
  return entries;
};

const extensionBoundaryChecker = createExtensionImportBoundaryChecker<CollectedBoundaryEntry>({
  roots: [BUNDLED_PLUGIN_ROOT_DIR],
  sourceOptions: {
    fileExtensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    includeTests: true,
    skipDirectories: ["dist"],
  },
  shouldSkipFile(relativeFile) {
    return (
      generatedExtensionAssetSources.has(relativeFile) ||
      path.basename(relativeFile).includes("__rootdir_boundary_canary__") ||
      classifyBundledExtensionSourcePath(relativeFile).isTestLike
    );
  },
  acceptSpecifier(specifier, { relativeFile, resolvedPath }) {
    if (!resolvedPath) {
      return false;
    }
    const extensionRoot = relativeFile.split("/").slice(0, 2).join("/");
    return (
      resolvedPath.startsWith("src/") ||
      (specifier.startsWith(".") &&
        resolvedPath !== extensionRoot &&
        !resolvedPath.startsWith(extensionRoot + "/"))
    );
  },
  collectEntries: collectBoundaryEntries,
  compareEntries: (left, right) => compareEntries(left.entry, right.entry),
});

/** Collect the current extension plugin SDK boundary inventory. */
async function collectExtensionPluginSdkBoundaryInventory(mode: BoundaryMode) {
  if (!MODES.has(mode)) {
    throw new Error("Unknown mode: " + mode);
  }
  allInventoryByModePromise ??= extensionBoundaryChecker
    .collectInventory()
    .then((entries) =>
      Object.fromEntries(
        [...MODES].map((inventoryMode) => [
          inventoryMode,
          entries
            .filter(({ mode: entryMode }) => entryMode === inventoryMode)
            .map(({ entry }) => entry),
        ]),
      ),
    );
  return (await allInventoryByModePromise)[mode] ?? [];
}

/**
 * Reads the checked-in expected boundary inventory.
 */
export async function readExpectedInventory(mode: BaselineBoundaryMode): Promise<BoundaryEntry[]> {
  try {
    const inventory: unknown = JSON.parse(await fs.readFile(baselinePathByMode[mode], "utf8"));
    if (!isBoundaryEntryArray(inventory)) {
      throw new Error(`Invalid boundary inventory: ${baselinePathByMode[mode]}`);
    }
    return inventory;
  } catch (error) {
    if (
      (mode === "plugin-sdk-internal" || mode === "src-outside-plugin-sdk") &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

/**
 * Diffs expected and actual boundary inventory entries.
 */
export function diffInventory(expected: BoundaryEntry[], actual: BoundaryEntry[]) {
  const expectedKeys = new Set(expected.map((entry) => JSON.stringify(entry)));
  const actualKeys = new Set(actual.map((entry) => JSON.stringify(entry)));
  return {
    missing: expected
      .filter((entry) => !actualKeys.has(JSON.stringify(entry)))
      .toSorted(compareEntries),
    unexpected: actual
      .filter((entry) => !expectedKeys.has(JSON.stringify(entry)))
      .toSorted(compareEntries),
  };
}

const formatInventoryHuman = (mode: BoundaryMode, inventory: BoundaryEntry[]): string =>
  formatGroupedInventoryHuman(
    {
      rule: ruleTextByMode[mode],
      cleanMessage: "No extension plugin-sdk boundary violations found.",
      inventoryTitle: "Extension boundary inventory:",
    },
    inventory,
  );

/**
 * Runs the boundary inventory check with CLI-style inputs and outputs.
 */
async function runExtensionPluginSdkBoundaryCheck(argv?: string[], io?: BoundaryCheckIo) {
  const args = argv ?? process.argv.slice(2);
  const streams = io ?? { stdout: process.stdout, stderr: process.stderr };
  const json = args.includes("--json");
  const modeArg = args.find((arg) => arg.startsWith("--mode="));
  const modeValue = modeArg?.slice("--mode=".length) ?? "src-outside-plugin-sdk";
  const mode = [...MODES].find((candidate) => candidate === modeValue);
  if (!mode) {
    throw new Error(`Unknown mode: ${modeValue}`);
  }

  const actual = await collectExtensionPluginSdkBoundaryInventory(mode);
  if (json) {
    writeLine(streams.stdout, JSON.stringify(actual, null, 2));
    return 0;
  }

  writeLine(streams.stdout, formatInventoryHuman(mode, actual));
  if (mode === "relative-outside-package") {
    if (actual.length === 0) {
      return 0;
    }
    writeLine(
      streams.stderr,
      `Relative outside-package violations found (${actual.length}); this mode no longer uses a baseline.`,
    );
    return 1;
  }

  const expected = await readExpectedInventory(mode);
  const diff = diffInventory(expected, actual);
  if (diff.missing.length === 0 && diff.unexpected.length === 0) {
    writeLine(streams.stdout, `Baseline matches (${actual.length} entries).`);
    return 0;
  }
  if (diff.missing.length > 0) {
    writeLine(streams.stderr, `Missing baseline entries (${diff.missing.length}):`);
    for (const entry of diff.missing) {
      writeLine(streams.stderr, `  - ${entry.file}:${entry.line} ${entry.reason}`);
    }
  }
  if (diff.unexpected.length > 0) {
    writeLine(streams.stderr, `Unexpected inventory entries (${diff.unexpected.length}):`);
    for (const entry of diff.unexpected) {
      writeLine(streams.stderr, `  - ${entry.file}:${entry.line} ${entry.reason}`);
    }
  }
  return 1;
}

/**
 * Entrypoint wrapper for the extension plugin SDK boundary check.
 */
export async function main(argv?: string[], io?: BoundaryCheckIo): Promise<0 | 1> {
  const exitCode = await runExtensionPluginSdkBoundaryCheck(argv, io);
  if (!io) {
    process.exitCode = exitCode;
  }
  return exitCode;
}

runAsScript(import.meta.url, main);
