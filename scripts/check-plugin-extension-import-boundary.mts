#!/usr/bin/env node

// Inventories core plugin imports that cross into bundled extension files.
import { existsSync } from "node:fs";
import path from "node:path";
import { createExtensionImportBoundaryChecker } from "./lib/extension-import-boundary-checker.mts";
import {
  formatGroupedInventoryHuman,
  resolveRepoSpecifier,
  writeLine,
} from "./lib/guard-inventory-utils.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { runAsScript } from "./lib/ts-guard-utils.mts";

const repoRoot = resolveRepoRoot(import.meta.url);
const AUTHORED_MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const RETIRED_WEB_SEARCH_CORE_MODULES = [
  "src/agents/tools/web-search-plugin-factory",
  "src/plugins/bundled-web-search-registry",
  "src/plugins/web-search-providers",
] as const;

type PluginExtensionInventoryEntry = {
  file: string;
  line: number;
  kind: string;
  specifier: string;
  resolvedPath: string | null;
  reason: string;
};
type ScriptIo = {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
};

function compareEntries(left: PluginExtensionInventoryEntry, right: PluginExtensionInventoryEntry) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier) ||
    left.reason.localeCompare(right.reason)
  );
}

function classifyResolvedExtensionReason(kind: string, resolvedPath: string | null) {
  const verb =
    kind === "export"
      ? "re-exports"
      : kind === "dynamic-import"
        ? "dynamically imports"
        : "imports";
  if (/^extensions\/[^/]+\/src\//.test(resolvedPath ?? "")) {
    return `${verb} extension implementation from src/plugins`;
  }
  if (/^extensions\/[^/]+\/index\.[^/]+$/.test(resolvedPath ?? "")) {
    return `${verb} extension entrypoint from src/plugins`;
  }
  return `${verb} extension-owned file from src/plugins`;
}

const boundaryChecker = createExtensionImportBoundaryChecker({
  roots: ["src/plugins"],
  shouldSkipFile(relativeFile) {
    return (
      relativeFile.startsWith("src/plugins/contracts/") ||
      /^src\/plugins\/runtime\/runtime-[^/]+-contract\.[cm]?[jt]s$/u.test(relativeFile)
    );
  },
  collectEntries({ filePath, relativeFile, references }) {
    return references.map(({ kind, line, specifier }) => {
      const resolvedPath = resolveRepoSpecifier(repoRoot, specifier, filePath);
      return {
        file: relativeFile,
        line,
        kind,
        specifier,
        resolvedPath,
        reason: classifyResolvedExtensionReason(kind, resolvedPath),
      };
    });
  },
  compareEntries,
});

/** Rejects retired core registries whose ownership now comes from plugin manifests. */
export function collectRetiredWebSearchCorePathEntries(
  rootDir = repoRoot,
): PluginExtensionInventoryEntry[] {
  return RETIRED_WEB_SEARCH_CORE_MODULES.flatMap((modulePath) =>
    AUTHORED_MODULE_EXTENSIONS.map((extension) => `${modulePath}${extension}`),
  )
    .filter((relativeFile) => existsSync(path.join(rootDir, relativeFile)))
    .map((relativeFile) => ({
      file: relativeFile,
      line: 1,
      kind: "retired-path",
      specifier: relativeFile,
      resolvedPath: relativeFile,
      reason: "restores retired core web-search registry or factory ownership",
    }));
}

/** Inventory of src/plugins extension imports and retired core web-search ownership paths. */
async function collectPluginExtensionImportBoundaryInventory() {
  return [
    ...(await boundaryChecker.collectInventory()),
    ...collectRetiredWebSearchCorePathEntries(),
  ].toSorted(compareEntries);
}

const ruleText =
  "Rule: src/plugins/** must not import bundled plugin files or restore retired web-search registries";
const formatInventoryHuman = (inventory: PluginExtensionInventoryEntry[]) =>
  formatGroupedInventoryHuman(
    {
      rule: ruleText,
      cleanMessage: "No plugin import boundary violations found.",
      inventoryTitle: "Plugin extension import boundary inventory:",
    },
    inventory,
  );

/**
 * Runs the plugin-extension import boundary check.
 */
async function runPluginExtensionImportBoundaryCheck(
  argv: string[] = process.argv.slice(2),
  streams: ScriptIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<0 | 1> {
  const json = argv.includes("--json");
  const actual = await collectPluginExtensionImportBoundaryInventory();

  if (json) {
    writeLine(streams.stdout, JSON.stringify(actual, null, 2));
    return actual.length > 0 ? 1 : 0;
  }

  writeLine(streams.stdout, formatInventoryHuman(actual));
  if (actual.length === 0) {
    return 0;
  }
  writeLine(streams.stderr, `${ruleText} violations found (${actual.length}).`);
  return 1;
}

/**
 * Entrypoint wrapper for the plugin-extension import boundary check.
 */
export async function main(argv?: string[], io?: ScriptIo): Promise<0 | 1> {
  const exitCode = await runPluginExtensionImportBoundaryCheck(argv, io);
  if (!io) {
    process.exitCode = exitCode;
  }
  return exitCode;
}

runAsScript(import.meta.url, main);
