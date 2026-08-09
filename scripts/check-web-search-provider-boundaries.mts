#!/usr/bin/env node

// Inventories core web-search surfaces that still mention bundled providers.
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { diffInventoryEntries, runBaselineInventoryCheck } from "./lib/guard-inventory-utils.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { collectSourceFileContents } from "./lib/source-file-scan-cache.mts";
import { runAsScript } from "./lib/ts-guard-utils.mts";
const repoRoot = resolveRepoRoot(import.meta.url);
const baselinePath = path.join(
  repoRoot,
  "test",
  "fixtures",
  "web-search-provider-boundary-inventory.json",
);

const scanRoots = ["src"];
const scanExtensions = new Set([".ts", ".js", ".mjs", ".cjs"]);
const ignoredDirNames = new Set([
  ".artifacts",
  ".git",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "extensions",
  "node_modules",
]);

const bundledProviderPluginToSearchProvider = new Map([
  ["brave", "brave"],
  ["firecrawl", "firecrawl"],
  ["google", "gemini"],
  ["moonshot", "kimi"],
  ["perplexity", "perplexity"],
  ["xai", "grok"],
]);

const providerIds = new Set([
  "brave",
  "firecrawl",
  "gemini",
  "grok",
  "kimi",
  "perplexity",
  "shared",
]);

const allowedGenericFiles = new Set([
  "src/agents/tools/web-search.ts",
  "src/commands/onboard-search.ts",
  "src/plugins/bundled-web-search-registry.ts",
  "src/secrets/runtime-web-tools.ts",
  "src/web-search/runtime.ts",
]);

const ignoredFiles = new Set([
  "src/config/config.web-search-provider.test.ts",
  "src/plugins/contracts/loader.contract.test.ts",
  "src/plugins/contracts/registry.contract.test.ts",
  "src/plugins/web-search-providers.test.ts",
  "src/secrets/runtime-web-tools.test.ts",
]);

const inventoryEntrySchema = z.looseObject({
  file: z.string(),
  line: z.number(),
  provider: z.string(),
  reason: z.string(),
});
type InventoryEntry = z.infer<typeof inventoryEntrySchema>;
type ScriptIo = {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
};

let webSearchProviderInventoryPromise: Promise<InventoryEntry[]> | undefined;

function compareInventoryEntries(left: InventoryEntry, right: InventoryEntry) {
  return (
    left.provider.localeCompare(right.provider) ||
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.reason.localeCompare(right.reason)
  );
}

function pushEntry(inventory: InventoryEntry[], entry: InventoryEntry) {
  if (!providerIds.has(entry.provider)) {
    throw new Error(`Unknown provider id in boundary inventory: ${entry.provider}`);
  }
  inventory.push(entry);
}

function scanWebSearchProviderRegistry(
  lines: string[],
  relativeFile: string,
  inventory: InventoryEntry[],
) {
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;

    if (line.includes("firecrawl-search-provider.js")) {
      pushEntry(inventory, {
        provider: "shared",
        file: relativeFile,
        line: lineNumber,
        reason: "imports extension web search provider implementation into core registry",
      });
    }

    if (line.includes("web-search-plugin-factory.js")) {
      pushEntry(inventory, {
        provider: "shared",
        file: relativeFile,
        line: lineNumber,
        reason: "imports shared web search provider registration helper into core registry",
      });
    }

    const pluginMatch = line.match(/pluginId:\s*"([^"]+)"/);
    const pluginId = pluginMatch?.[1];
    const providerFromPlugin = pluginId
      ? bundledProviderPluginToSearchProvider.get(pluginId)
      : undefined;
    if (providerFromPlugin) {
      pushEntry(inventory, {
        provider: providerFromPlugin,
        file: relativeFile,
        line: lineNumber,
        reason: "hardcodes bundled web search plugin ownership in core registry",
      });
    }

    const providerMatch = line.match(/id:\s*"(brave|firecrawl|gemini|grok|kimi|perplexity)"/);
    const providerId = providerMatch?.[1];
    if (providerId) {
      pushEntry(inventory, {
        provider: providerId,
        file: relativeFile,
        line: lineNumber,
        reason: "hardcodes bundled web search provider id in core registry",
      });
    }
  }
}

function scanGenericCoreImports(
  lines: string[],
  relativeFile: string,
  inventory: InventoryEntry[],
) {
  if (allowedGenericFiles.has(relativeFile)) {
    return;
  }
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.includes("web-search-providers.js")) {
      pushEntry(inventory, {
        provider: "shared",
        file: relativeFile,
        line: lineNumber,
        reason: "imports bundled web search registry outside allowed generic plumbing",
      });
    }
    if (line.includes("web-search-plugin-factory.js")) {
      pushEntry(inventory, {
        provider: "shared",
        file: relativeFile,
        line: lineNumber,
        reason: "imports web search provider registration helper outside extensions",
      });
    }
  }
}

/**
 * Collects web-search provider boundary inventory from core source files.
 */
async function collectWebSearchProviderBoundaryInventory() {
  if (!webSearchProviderInventoryPromise) {
    webSearchProviderInventoryPromise = (async () => {
      const inventory: InventoryEntry[] = [];
      const files = await collectSourceFileContents({
        repoRoot,
        scanRoots,
        scanExtensions,
        ignoredDirNames,
      });

      for (const { relativeFile, content } of files) {
        if (ignoredFiles.has(relativeFile) || relativeFile.includes(".test.")) {
          continue;
        }
        const lines = content.split(/\r?\n/);

        if (relativeFile === "src/plugins/web-search-providers.ts") {
          scanWebSearchProviderRegistry(lines, relativeFile, inventory);
          continue;
        }

        scanGenericCoreImports(lines, relativeFile, inventory);
      }

      return inventory.toSorted(compareInventoryEntries);
    })();
  }
  return await webSearchProviderInventoryPromise;
}

/**
 * Reads the expected web-search provider boundary inventory baseline.
 */
async function readExpectedInventory(): Promise<InventoryEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(baselinePath, "utf8"));
    const result = z.array(inventoryEntrySchema).safeParse(parsed);
    return result.success ? result.data : [];
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Diffs expected and actual web-search provider boundary inventory entries.
 */
function diffInventory(expected: InventoryEntry[], actual: InventoryEntry[]) {
  return diffInventoryEntries(expected, actual, compareInventoryEntries);
}

function formatInventoryHuman(inventory: InventoryEntry[]) {
  if (inventory.length === 0) {
    return "No web search provider boundary inventory entries found.";
  }
  const lines = ["Web search provider boundary inventory:"];
  let activeProvider = "";
  for (const entry of inventory) {
    if (entry.provider !== activeProvider) {
      activeProvider = entry.provider;
      lines.push(`${activeProvider}:`);
    }
    lines.push(`  - ${entry.file}:${entry.line} ${entry.reason}`);
  }
  return lines.join("\n");
}

function formatEntry(entry: InventoryEntry) {
  return `${entry.provider} ${entry.file}:${entry.line} ${entry.reason}`;
}

/**
 * Runs the web-search provider boundary baseline check.
 */
async function runWebSearchProviderBoundaryCheck(argv?: string[], io?: ScriptIo) {
  return await runBaselineInventoryCheck({
    argv: argv ?? process.argv.slice(2),
    io,
    collectActual: collectWebSearchProviderBoundaryInventory,
    readExpected: readExpectedInventory,
    diffInventory,
    formatInventoryHuman,
    formatEntry,
  });
}

/**
 * Entrypoint wrapper for the web-search provider boundary check.
 */
export async function main(argv?: string[], io?: ScriptIo) {
  const exitCode = await runWebSearchProviderBoundaryCheck(argv, io);
  if (!io && exitCode !== 0) {
    process.exit(exitCode);
  }
  return exitCode;
}

runAsScript(import.meta.url, main);
