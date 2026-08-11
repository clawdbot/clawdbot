#!/usr/bin/env node

// Inventories core plugin imports that cross into bundled extension files.
import { promises as fs } from "node:fs";
import path from "node:path";
import { createExtensionImportBoundaryChecker } from "./lib/extension-import-boundary-checker.mts";
import {
  createCachedAsync,
  diffInventoryEntries,
  formatGroupedInventoryHuman,
  runBaselineInventoryCheck,
  resolveRepoSpecifier,
} from "./lib/guard-inventory-utils.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { runAsScript } from "./lib/ts-guard-utils.mts";

const repoRoot = resolveRepoRoot(import.meta.url);
const baselinePath = path.join(
  repoRoot,
  "test",
  "fixtures",
  "plugin-extension-import-boundary-inventory.json",
);

const bundledWebSearchProviders = new Set([
  "brave",
  "firecrawl",
  "gemini",
  "grok",
  "kimi",
  "perplexity",
]);
const bundledWebSearchPluginIds = new Set([
  "brave",
  "firecrawl",
  "google",
  "moonshot",
  "perplexity",
  "xai",
]);

type PluginExtensionInventoryEntry = {
  file: string;
  line: number;
  kind: string;
  specifier: string;
  resolvedPath: string | null;
  reason: string;
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

function scanWebSearchRegistrySmells(
  source: string,
  relativeFile: string,
): PluginExtensionInventoryEntry[] {
  if (relativeFile !== "src/plugins/web-search-providers.ts") {
    return [];
  }

  const entries: PluginExtensionInventoryEntry[] = [];
  const lines = source.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;

    if (line.includes("web-search-plugin-factory.js")) {
      entries.push({
        file: relativeFile,
        line: lineNumber,
        kind: "registry-smell",
        specifier: "../agents/tools/web-search-plugin-factory.js",
        resolvedPath: "src/agents/tools/web-search-plugin-factory.js",
        reason: "imports core-owned web search provider factory into plugin registry",
      });
    }

    const pluginMatch = line.match(/pluginId:\s*"([^"]+)"/);
    const pluginId = pluginMatch?.[1];
    if (pluginId && bundledWebSearchPluginIds.has(pluginId)) {
      entries.push({
        file: relativeFile,
        line: lineNumber,
        kind: "registry-smell",
        specifier: pluginId,
        resolvedPath: relativeFile,
        reason: "hardcodes bundled web search plugin ownership in core registry",
      });
    }

    const providerMatch = line.match(/id:\s*"(brave|firecrawl|gemini|grok|kimi|perplexity)"/);
    const providerId = providerMatch?.[1];
    if (providerId && bundledWebSearchProviders.has(providerId)) {
      entries.push({
        file: relativeFile,
        line: lineNumber,
        kind: "registry-smell",
        specifier: providerId,
        resolvedPath: relativeFile,
        reason: "hardcodes bundled web search provider metadata in core registry",
      });
    }
  }

  return entries;
}

const boundaryChecker = createExtensionImportBoundaryChecker({
  roots: ["src/plugins"],
  shouldSkipFile(relativeFile) {
    return (
      relativeFile === "src/plugins/bundled-web-search-registry.ts" ||
      relativeFile.startsWith("src/plugins/contracts/") ||
      /^src\/plugins\/runtime\/runtime-[^/]+-contract\.[cm]?[jt]s$/u.test(relativeFile)
    );
  },
  collectEntries({ source, filePath, relativeFile, references }) {
    return [
      ...references.map(({ kind, line, specifier }) => {
        const resolvedPath = resolveRepoSpecifier(repoRoot, specifier, filePath);
        return {
          file: relativeFile,
          line,
          kind,
          specifier,
          resolvedPath,
          reason: classifyResolvedExtensionReason(kind, resolvedPath),
        };
      }),
      ...scanWebSearchRegistrySmells(source, relativeFile),
    ];
  },
  compareEntries,
});

/** Cached inventory of src/plugins imports that cross into bundled extensions. */
const collectPluginExtensionImportBoundaryInventory = boundaryChecker.collectInventory;

/**
 * Cached expected plugin-extension import inventory baseline.
 */
const readExpectedInventory = createCachedAsync(
  async (): Promise<PluginExtensionInventoryEntry[]> =>
    JSON.parse(await fs.readFile(baselinePath, "utf8")),
);

/**
 * Diffs expected and actual plugin-extension boundary inventory entries.
 */
function diffInventory(
  expected: PluginExtensionInventoryEntry[],
  actual: PluginExtensionInventoryEntry[],
) {
  return diffInventoryEntries(expected, actual, compareEntries);
}

const formatInventoryHuman = (inventory: PluginExtensionInventoryEntry[]) =>
  formatGroupedInventoryHuman(
    {
      rule: "Rule: src/plugins/** must not import bundled plugin files",
      cleanMessage: "No plugin import boundary violations found.",
      inventoryTitle: "Plugin extension import boundary inventory:",
    },
    inventory,
  );

function formatEntry(entry: PluginExtensionInventoryEntry) {
  return `${entry.file}:${entry.line} [${entry.kind}] ${entry.reason} (${entry.specifier} -> ${entry.resolvedPath})`;
}

/**
 * Runs the plugin-extension import boundary baseline check.
 */
async function runPluginExtensionImportBoundaryCheck(argv?: string[], io?: unknown) {
  return await runBaselineInventoryCheck({
    argv: argv ?? process.argv.slice(2),
    io,
    collectActual: collectPluginExtensionImportBoundaryInventory,
    readExpected: readExpectedInventory,
    diffInventory,
    formatInventoryHuman,
    formatEntry,
  });
}

/**
 * Entrypoint wrapper for the plugin-extension import boundary check.
 */
export async function main(argv?: string[], io?: unknown) {
  const exitCode = await runPluginExtensionImportBoundaryCheck(argv, io);
  if (!io && exitCode !== 0) {
    process.exit(exitCode);
  }
  return exitCode;
}

runAsScript(import.meta.url, main);
