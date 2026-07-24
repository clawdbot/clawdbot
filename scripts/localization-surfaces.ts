import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type SurfaceAdapter = {
  id: string;
  owner: string;
  roots: readonly string[];
  extensions: readonly string[];
  excludedRoots: readonly string[];
};

type SurfaceDisposition =
  | {
      id: string;
      owner: string;
      source: string;
      disposition: "adopted";
      catalogArea: string;
    }
  | {
      id: string;
      owner: string;
      source: string;
      disposition: "conforming-pipeline";
      pipeline: string;
    }
  | {
      id: string;
      owner: string;
      source: string;
      disposition: "deferred" | "english-only" | "platform-constrained";
      rationale: string;
    };

type SurfaceRegistry = {
  schemaVersion: 1;
  adapters: readonly SurfaceAdapter[];
  surfaces: readonly SurfaceDisposition[];
};

const DEFAULT_REGISTRY_PATH = "localization/surfaces.json";
const DEFAULT_CATALOG_REGISTRY_PATH = "localization/catalogs.json";
type SurfaceDispositionKind = SurfaceDisposition["disposition"];

const DISPOSITIONS = new Set<SurfaceDispositionKind>([
  "adopted",
  "conforming-pipeline",
  "deferred",
  "english-only",
  "platform-constrained",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function expectStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value.map((entry, index) => expectString(entry, `${label}[${index}]`));
}

function expectRepoPath(value: unknown, label: string): string {
  const raw = expectString(value, label);
  const normalized = path.posix.normalize(raw);
  if (
    raw.includes("\\") ||
    /^[A-Za-z]:\//u.test(raw) ||
    path.isAbsolute(raw) ||
    path.posix.isAbsolute(raw) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    raw !== normalized
  ) {
    throw new Error(`${label} must be a normalized repository-relative path`);
  }
  return normalized;
}

function expectExtension(value: unknown, label: string): string {
  const extension = expectString(value, label);
  if (!extension.startsWith(".") || extension.includes("/")) {
    throw new Error(`${label} must be a file extension such as .json`);
  }
  return extension;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicates`);
  }
}

function isDisposition(value: string): value is SurfaceDispositionKind {
  return DISPOSITIONS.has(value as SurfaceDispositionKind);
}

function readDisposition(entry: unknown, index: number): SurfaceDisposition {
  if (!isRecord(entry)) {
    throw new Error(`surfaces[${index}] must be an object`);
  }
  const id = expectString(entry.id, `surfaces[${index}].id`);
  const owner = expectString(entry.owner, `surfaces[${index}].owner`);
  const source = expectRepoPath(entry.source, `surfaces[${index}].source`);
  const disposition = expectString(entry.disposition, `surfaces[${index}].disposition`);
  if (!isDisposition(disposition)) {
    throw new Error(`surfaces[${index}].disposition is unsupported: ${disposition}`);
  }
  if (disposition === "adopted") {
    return {
      id,
      owner,
      source,
      disposition,
      catalogArea: expectString(entry.catalogArea, `surfaces[${index}].catalogArea`),
    };
  }
  if (disposition === "conforming-pipeline") {
    return {
      id,
      owner,
      source,
      disposition,
      pipeline: expectString(entry.pipeline, `surfaces[${index}].pipeline`),
    };
  }
  return {
    id,
    owner,
    source,
    disposition,
    rationale: expectString(entry.rationale, `surfaces[${index}].rationale`),
  };
}

async function readRegistry(root: string, registryPath: string): Promise<SurfaceRegistry> {
  const raw = await readJson(path.resolve(root, registryPath));
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.adapters) ||
    !Array.isArray(raw.surfaces)
  ) {
    throw new Error(
      "localization surface registry must use schemaVersion 1 and declare adapters and surfaces",
    );
  }
  if (raw.adapters.length === 0 || raw.surfaces.length === 0) {
    throw new Error("localization surface registry must declare an adapter and a surface");
  }
  const adapters = raw.adapters.map((entry, index): SurfaceAdapter => {
    if (!isRecord(entry)) {
      throw new Error(`adapters[${index}] must be an object`);
    }
    const roots = expectStringArray(entry.roots, `adapters[${index}].roots`).map(
      (value, rootIndex) => expectRepoPath(value, `adapters[${index}].roots[${rootIndex}]`),
    );
    const excludedRoots = Array.isArray(entry.excludedRoots)
      ? entry.excludedRoots.map((value, excludedIndex) =>
          expectRepoPath(value, `adapters[${index}].excludedRoots[${excludedIndex}]`),
        )
      : [];
    for (const excludedRoot of excludedRoots) {
      if (!roots.some((rootPath) => excludedRoot.startsWith(`${rootPath}/`))) {
        throw new Error(
          `adapters[${index}].excludedRoots must stay below, not replace, a declared root`,
        );
      }
    }
    const extensions = expectStringArray(entry.extensions, `adapters[${index}].extensions`).map(
      (value, extensionIndex) =>
        expectExtension(value, `adapters[${index}].extensions[${extensionIndex}]`),
    );
    assertUnique(roots, `adapters[${index}].roots`);
    assertUnique(excludedRoots, `adapters[${index}].excludedRoots`);
    assertUnique(extensions, `adapters[${index}].extensions`);
    return {
      id: expectString(entry.id, `adapters[${index}].id`),
      owner: expectString(entry.owner, `adapters[${index}].owner`),
      roots,
      extensions,
      excludedRoots,
    };
  });
  const surfaces = raw.surfaces.map(readDisposition);
  assertUnique(
    adapters.map((adapter) => adapter.id),
    "adapter ids",
  );
  assertUnique(
    surfaces.map((surface) => surface.id),
    "surface ids",
  );
  assertUnique(
    surfaces.map((surface) => surface.source),
    "surface sources",
  );
  return { schemaVersion: 1, adapters, surfaces };
}

function isExcluded(repoPath: string, excludedRoots: readonly string[]): boolean {
  return excludedRoots.some(
    (excludedRoot) => repoPath === excludedRoot || repoPath.startsWith(`${excludedRoot}/`),
  );
}

async function discoverRoot(
  root: string,
  repoPath: string,
  adapter: SurfaceAdapter,
  discovered: Map<string, string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(path.resolve(root, repoPath), { withFileTypes: true });
  } catch (error) {
    throw new Error(`adapter ${adapter.id} cannot read declared root ${repoPath}`, {
      cause: error,
    });
  }
  for (const entry of entries.toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const childPath = path.posix.join(repoPath, entry.name);
    if (isExcluded(childPath, adapter.excludedRoots)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`adapter ${adapter.id} encountered symbolic link ${childPath}`);
    }
    if (entry.isDirectory()) {
      await discoverRoot(root, childPath, adapter, discovered);
      continue;
    }
    if (!entry.isFile() || !adapter.extensions.includes(path.posix.extname(entry.name))) {
      continue;
    }
    const previousAdapter = discovered.get(childPath);
    if (previousAdapter) {
      throw new Error(`${childPath} is discovered by both ${previousAdapter} and ${adapter.id}`);
    }
    discovered.set(childPath, adapter.id);
  }
}

async function assertRootDirectory(
  root: string,
  repoPath: string,
  adapterId: string,
): Promise<void> {
  let currentPath = path.resolve(root);
  for (const segment of repoPath.split("/")) {
    currentPath = path.join(currentPath, segment);
    let stats;
    try {
      stats = await lstat(currentPath);
    } catch (error) {
      throw new Error(`adapter ${adapterId} cannot read declared root ${repoPath}`, {
        cause: error,
      });
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`adapter ${adapterId} declared root traverses symbolic link ${repoPath}`);
    }
  }
  const rootStats = await lstat(currentPath);
  if (!rootStats.isDirectory()) {
    throw new Error(`adapter ${adapterId} declared root is not a directory: ${repoPath}`);
  }
}

async function discoverSurfaces(root: string, adapters: readonly SurfaceAdapter[]) {
  const discovered = new Map<string, string>();
  for (const adapter of adapters) {
    for (const rootPath of adapter.roots) {
      await assertRootDirectory(root, rootPath, adapter.id);
      await discoverRoot(root, rootPath, adapter, discovered);
    }
  }
  return discovered;
}

async function readCatalogSources(
  root: string,
  registryPath: string,
): Promise<Map<string, string>> {
  const raw = await readJson(path.resolve(root, registryPath));
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.areas)) {
    throw new Error("localization catalog registry must use schemaVersion 1 and declare areas");
  }
  const sources = new Map<string, string>();
  raw.areas.forEach((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`catalog areas[${index}] must be an object`);
    }
    const id = expectString(entry.id, `catalog areas[${index}].id`);
    if (sources.has(id)) {
      throw new Error(`catalog registry contains duplicate area ${id}`);
    }
    sources.set(id, expectRepoPath(entry.source, `catalog areas[${index}].source`));
  });
  return sources;
}

export async function checkSurfaceDispositions(
  options: { root?: string; registryPath?: string; catalogRegistryPath?: string } = {},
): Promise<number> {
  const root = options.root ?? process.cwd();
  const registry = await readRegistry(root, options.registryPath ?? DEFAULT_REGISTRY_PATH);
  const discovered = await discoverSurfaces(root, registry.adapters);
  const dispositions = new Map(registry.surfaces.map((surface) => [surface.source, surface]));
  const adaptersById = new Map(registry.adapters.map((adapter) => [adapter.id, adapter]));
  for (const [source, adapterId] of discovered) {
    const disposition = dispositions.get(source);
    if (!disposition) {
      throw new Error(
        `new product-string surface ${source} from adapter ${adapterId} has no localization disposition`,
      );
    }
    const adapter = adaptersById.get(adapterId);
    if (adapter?.owner !== disposition.owner) {
      throw new Error(
        `surface ${disposition.id} owner ${disposition.owner} does not match adapter ${adapterId} owner ${adapter?.owner}`,
      );
    }
  }
  for (const surface of registry.surfaces) {
    if (!discovered.has(surface.source)) {
      throw new Error(`surface ${surface.id} declares undiscovered source ${surface.source}`);
    }
  }
  const catalogSources = await readCatalogSources(
    root,
    options.catalogRegistryPath ?? DEFAULT_CATALOG_REGISTRY_PATH,
  );
  for (const surface of registry.surfaces) {
    if (surface.disposition !== "adopted") {
      continue;
    }
    const catalogSource = catalogSources.get(surface.catalogArea);
    if (!catalogSource) {
      throw new Error(
        `surface ${surface.id} references unknown catalog area ${surface.catalogArea}`,
      );
    }
    if (catalogSource !== surface.source) {
      throw new Error(
        `surface ${surface.id} source ${surface.source} does not match catalog area ${surface.catalogArea} source ${catalogSource}`,
      );
    }
  }
  return discovered.size;
}

async function main() {
  const count = await checkSurfaceDispositions();
  process.stdout.write(`validated ${count} localization surface disposition(s)\n`);
}

function isCliEntrypoint() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href);
}

if (isCliEntrypoint()) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
