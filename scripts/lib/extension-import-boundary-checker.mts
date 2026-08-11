// Creates reusable import-boundary guards for bundled extension source trees.
import { promises as fs } from "node:fs";
import pMap from "p-map";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "./bundled-plugin-paths.mjs";
import {
  collectModuleReferencesFromSource,
  createCachedAsync,
  formatGroupedInventoryHuman,
  normalizeRepoPath,
  resolveRepoSpecifier,
  writeLine,
} from "./guard-inventory-utils.mjs";
import { resolveRepoRoot } from "./repo-root.mjs";
import { collectTypeScriptFilesFromRoots, resolveSourceRoots } from "./ts-guard-utils.mts";

type ModuleReference = { kind: string; line: number; specifier: string };

type BoundaryViolation = {
  file: string;
  line: number;
  kind: string;
  specifier: string;
  resolvedPath: string;
  reason: string;
};

type ResolvedPathContext = {
  kind: string;
  specifier: string;
  file: string;
};

type SpecifierContext = {
  filePath: string;
  relativeFile: string;
  resolvedPath: string | null;
};

type CollectEntriesContext = {
  source: string;
  filePath: string;
  relativeFile: string;
  references: ModuleReference[];
};

type BoundaryCheckerParams<Entry> = {
  roots: string[];
  sourceOptions?: Record<string, unknown>;
  maxSourceBytes?: unknown;
  boundaryLabel?: string;
  skipSourcesWithoutBundledPluginPrefix?: boolean;
  shouldSkipFile?: (relativeFile: string) => boolean;
  acceptSpecifier?: (specifier: string, context: SpecifierContext) => boolean;
  collectEntries?: (context: CollectEntriesContext) => Entry[];
  allowResolvedPath?: (resolvedPath: string, context: ResolvedPathContext) => boolean;
  compareEntries?: (left: Entry, right: Entry) => number;
  [key: string]: unknown;
};

type BoundaryCheckerIo = {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
};

const repoRoot = resolveRepoRoot(import.meta.url);
const DEFAULT_BOUNDARY_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
// Escaped plugin paths must reach the scanner without lexing every unrelated escaped source.
const ESCAPED_BUNDLED_PLUGIN_PATH_PREFIX_RE = new RegExp(
  Array.from(BUNDLED_PLUGIN_PATH_PREFIX, (character) => {
    const hex = character.charCodeAt(0).toString(16).padStart(2, "0");
    return (
      "(?:" +
      character +
      "|\\\\(?:x" +
      hex +
      "|u00" +
      hex +
      "|u\\{0*" +
      hex +
      "\\}|" +
      character +
      "))(?:\\\\(?:\\r\\n|[\\r\\n\\u2028\\u2029]))*"
    );
  }).join(""),
  "iu",
);

function compareEntries(left: BoundaryViolation, right: BoundaryViolation): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.kind.localeCompare(right.kind) ||
    left.specifier.localeCompare(right.specifier) ||
    left.reason.localeCompare(right.reason)
  );
}

function classifyResolvedExtensionReason(kind: string, boundaryLabel: string | undefined): string {
  const verb =
    kind === "export"
      ? "re-exports"
      : kind === "dynamic-import"
        ? "dynamically imports"
        : "imports";
  return `${verb} bundled plugin file from ${boundaryLabel} boundary`;
}

function scanImportBoundaryViolations(
  references: ModuleReference[],
  filePath: string,
  boundaryLabel: string | undefined,
  allowResolvedPath?: (resolvedPath: string, context: ResolvedPathContext) => boolean,
): BoundaryViolation[] {
  const entries: BoundaryViolation[] = [];
  const relativeFile = normalizeRepoPath(repoRoot, filePath);

  for (const { kind, line, specifier } of references) {
    const resolvedPath = resolveRepoSpecifier(repoRoot, specifier, filePath);
    if (!resolvedPath?.startsWith(BUNDLED_PLUGIN_PATH_PREFIX)) {
      continue;
    }
    if (allowResolvedPath?.(resolvedPath, { kind, specifier, file: relativeFile })) {
      continue;
    }
    entries.push({
      file: relativeFile,
      line,
      kind,
      specifier,
      resolvedPath,
      reason: classifyResolvedExtensionReason(kind, boundaryLabel),
    });
  }

  return entries;
}

function normalizeMaxSourceBytes(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_BOUNDARY_SOURCE_MAX_BYTES;
}

function assertSourceFileWithinLimit(filePath: string, bytes: number, maxBytes: number): void {
  if (bytes <= maxBytes) {
    return;
  }
  throw new Error(
    `extension import boundary source file exceeds ${maxBytes} byte limit: ${normalizeRepoPath(
      repoRoot,
      filePath,
    )} (${bytes} bytes)`,
  );
}

async function readBoundedSourceFile(filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.stat(filePath);
  assertSourceFileWithinLimit(filePath, stat.size, maxBytes);
  const source = await fs.readFile(filePath, "utf8");
  assertSourceFileWithinLimit(filePath, Buffer.byteLength(source, "utf8"), maxBytes);
  return source;
}

/** Create a boundary checker with cached inventory collection and a CLI-style main function. */
export function createExtensionImportBoundaryChecker<Entry = BoundaryViolation>(
  params: BoundaryCheckerParams<Entry>,
) {
  const scanRoots = resolveSourceRoots(repoRoot, params.roots);
  const maxSourceBytes = normalizeMaxSourceBytes(params.maxSourceBytes);

  const collectInventory = createCachedAsync(async () => {
    const files = (await collectTypeScriptFilesFromRoots(scanRoots, params.sourceOptions))
      .filter((filePath) => !params.shouldSkipFile?.(normalizeRepoPath(repoRoot, filePath)))
      .toSorted((left, right) =>
        normalizeRepoPath(repoRoot, left).localeCompare(normalizeRepoPath(repoRoot, right)),
      );
    const entriesByFile = await pMap(
      files,
      async (filePath) => {
        const source = await readBoundedSourceFile(filePath, maxSourceBytes);
        const relativeFile = normalizeRepoPath(repoRoot, filePath);
        if (
          params.skipSourcesWithoutBundledPluginPrefix &&
          !source.includes(BUNDLED_PLUGIN_PATH_PREFIX) &&
          (!source.includes("\\") || !ESCAPED_BUNDLED_PLUGIN_PATH_PREFIX_RE.test(source))
        ) {
          return [];
        }
        const references = collectModuleReferencesFromSource(source, {
          fileName: filePath,
          acceptSpecifier(specifier: string) {
            const resolvedPath = resolveRepoSpecifier(repoRoot, specifier, filePath);
            return params.acceptSpecifier
              ? params.acceptSpecifier(specifier, { filePath, relativeFile, resolvedPath })
              : Boolean(resolvedPath?.startsWith(BUNDLED_PLUGIN_PATH_PREFIX));
          },
        });
        return params.collectEntries
          ? params.collectEntries({ source, filePath, relativeFile, references })
          : scanImportBoundaryViolations(
              references,
              filePath,
              params.boundaryLabel,
              params.allowResolvedPath,
            );
      },
      { concurrency: 32, stopOnError: true },
    );
    const inventory = entriesByFile.flat() as Entry[];
    const compare =
      params.compareEntries ??
      ((left: Entry, right: Entry) =>
        compareEntries(left as BoundaryViolation, right as BoundaryViolation));
    return inventory.toSorted(compare);
  }) as () => Promise<Entry[]>;

  async function main(
    args: string[] = process.argv.slice(2),
    streams: BoundaryCheckerIo = { stdout: process.stdout, stderr: process.stderr },
  ): Promise<0 | 1> {
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
