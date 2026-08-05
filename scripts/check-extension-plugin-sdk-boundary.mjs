#!/usr/bin/env node

// Inventories extension imports to enforce plugin SDK boundary rules.
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BUNDLED_PLUGIN_PATH_PREFIX,
  BUNDLED_PLUGIN_ROOT_DIR,
} from "./lib/bundled-plugin-paths.mjs";
import { createExtensionImportBoundaryChecker } from "./lib/extension-import-boundary-checker.mjs";
import { classifyBundledExtensionSourcePath } from "./lib/extension-source-classifier.mjs";
import {
  diffInventoryEntries,
  formatGroupedInventoryHuman,
  resolveRepoSpecifier,
  writeLine,
} from "./lib/guard-inventory-utils.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { listGeneratedExtensionAssetSources } from "./lib/static-extension-assets.mjs";
import { runAsScript } from "./lib/ts-guard-utils.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);
// Generated bundles are validated at their build owner; they are not bounded authored source.
const generatedExtensionAssetSources = new Set(
  listGeneratedExtensionAssetSources({ rootDir: repoRoot }),
);

const MODES = new Set([
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
};

let allInventoryByModePromise;
const ruleTextByMode = {
  "src-outside-plugin-sdk":
    "Rule: production bundled plugins must not import src/** outside src/plugin-sdk/**",
  "plugin-sdk-internal":
    "Rule: production bundled plugins must not import src/plugin-sdk-internal/**",
  "relative-outside-package":
    "Rule: production bundled plugins must not use relative imports that escape their own package root",
};

function classifyReason(mode, kind, resolvedPath, specifier) {
  const verb =
    kind === "export"
      ? "re-exports"
      : kind === "dynamic-import"
        ? "dynamically imports"
        : "imports";
  if (mode === "relative-outside-package") {
    if (resolvedPath?.startsWith("src/plugin-sdk/")) {
      return `${verb} plugin-sdk via relative path; use openclaw/plugin-sdk/<subpath>`;
    }
    if (resolvedPath?.startsWith("src/")) {
      return `${verb} core src path via relative path outside the extension package`;
    }
    if (resolvedPath?.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
      return `${verb} another bundled plugin via relative path outside the extension package`;
    }
    return `${verb} relative path ${specifier} outside the extension package`;
  }
  if (mode === "plugin-sdk-internal") {
    return `${verb} src/plugin-sdk-internal from an extension`;
  }
  if (resolvedPath.startsWith("src/plugin-sdk/")) {
    return `${verb} allowed plugin-sdk path`;
  }
  return `${verb} core src path outside plugin-sdk from an extension`;
}

function compareEntries(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier) ||
    left.resolvedPath.localeCompare(right.resolvedPath) ||
    left.reason.localeCompare(right.reason)
  );
}

function collectBoundaryEntries({ filePath, relativeFile, references }) {
  const extensionRoot = relativeFile.split("/").slice(0, 2).join("/");
  const entries = [];
  for (const { kind, line, specifier } of references) {
    const resolvedPath = resolveRepoSpecifier(repoRoot, specifier, filePath);
    const modes = [];
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
}

const extensionBoundaryChecker = createExtensionImportBoundaryChecker({
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
async function collectExtensionPluginSdkBoundaryInventory(mode) {
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
  return (await allInventoryByModePromise)[mode];
}

/**
 * Reads the checked-in expected boundary inventory.
 */
export async function readExpectedInventory(mode) {
  try {
    return JSON.parse(await fs.readFile(baselinePathByMode[mode], "utf8"));
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
export function diffInventory(expected, actual) {
  return diffInventoryEntries(expected, actual, compareEntries);
}

const formatInventoryHuman = (mode, inventory) =>
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
async function runExtensionPluginSdkBoundaryCheck(argv, io) {
  const args = argv ?? process.argv.slice(2);
  const streams = io ?? { stdout: process.stdout, stderr: process.stderr };
  const json = args.includes("--json");
  const modeArg = args.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg?.slice("--mode=".length) ?? "src-outside-plugin-sdk";
  if (!MODES.has(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
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
export async function main(argv, io) {
  const exitCode = await runExtensionPluginSdkBoundaryCheck(argv, io);
  if (!io) {
    process.exitCode = exitCode;
  }
  return exitCode;
}

runAsScript(import.meta.url, main);
