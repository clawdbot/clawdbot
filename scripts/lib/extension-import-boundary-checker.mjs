import { promises as fs } from "node:fs";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "./bundled-plugin-paths.mjs";
import {
  collectModuleReferencesFromSource,
  createCachedAsync,
  formatGroupedInventoryHuman,
  normalizeRepoPath,
  resolveRepoSpecifier,
  writeLine,
} from "./guard-inventory-utils.mjs";
import {
  collectTypeScriptFilesFromRoots,
  resolveRepoRoot,
  resolveSourceRoots,
} from "./ts-guard-utils.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);

function compareEntries(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier) ||
    left.reason.localeCompare(right.reason)
  );
}

function classifyResolvedExtensionReason(kind, boundaryLabel) {
  const verb =
    kind === "export"
      ? "re-exports"
      : kind === "dynamic-import"
        ? "dynamically imports"
        : "imports";
  return `${verb} bundled plugin file from ${boundaryLabel} boundary`;
}

function scanImportBoundaryViolations(source, filePath, boundaryLabel, allowResolvedPath) {
  const entries = [];
  const relativeFile = normalizeRepoPath(repoRoot, filePath);

  for (const reference of collectModuleReferencesFromSource(source)) {
    const kind = reference.kind;
    const specifier = reference.specifier;
    const resolvedPath = resolveRepoSpecifier(repoRoot, specifier, filePath);
    if (!resolvedPath?.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
      continue;
    }
    if (allowResolvedPath?.(resolvedPath, { kind, specifier, file: relativeFile })) {
      continue;
    }
    entries.push({
      file: relativeFile,
      line: reference.line,
      kind,
      specifier,
      resolvedPath,
      reason: classifyResolvedExtensionReason(kind, boundaryLabel),
    });
  }

  return entries;
}

export function createExtensionImportBoundaryChecker(params) {
  const scanRoots = resolveSourceRoots(repoRoot, params.roots);

  const collectInventory = createCachedAsync(async () => {
    const files = (await collectTypeScriptFilesFromRoots(scanRoots))
      .filter((filePath) => !params.shouldSkipFile?.(normalizeRepoPath(repoRoot, filePath)))
      .toSorted((left, right) =>
        normalizeRepoPath(repoRoot, left).localeCompare(normalizeRepoPath(repoRoot, right)),
      );
    const entriesByFile = await Promise.all(
      files.map(async (filePath) => {
        const source = await fs.readFile(filePath, "utf8");
        if (
          params.skipSourcesWithoutBundledPluginPrefix &&
          !source.includes(BUNDLED_PLUGIN_PATH_PREFIX)
        ) {
          return [];
        }
        return scanImportBoundaryViolations(
          source,
          filePath,
          params.boundaryLabel,
          params.allowResolvedPath,
        );
      }),
    );
    const inventory = entriesByFile.flat();
    return inventory.toSorted(compareEntries);
  });

  async function main(argv, io) {
    const args = argv ?? process.argv.slice(2);
    const streams = io ?? { stdout: process.stdout, stderr: process.stderr };
    const json = args.includes("--json");
    const inventory = await collectInventory();

    if (json) {
      writeLine(streams.stdout, JSON.stringify(inventory, null, 2));
    } else {
      writeLine(streams.stdout, formatGroupedInventoryHuman(params, inventory));
      writeLine(
        streams.stdout,
        inventory.length === 0 ? "Boundary is clean." : "Boundary has violations.",
      );
    }

    return inventory.length === 0 ? 0 : 1;
  }

  return { collectInventory, main };
}
