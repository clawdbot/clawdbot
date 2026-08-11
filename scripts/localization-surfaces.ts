import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadCatalogRegistry, type CatalogArea } from "./localization-catalogs.js";

type SurfaceAdapter = {
  id: string;
  owner: string;
  roots: readonly string[];
  extensions: readonly string[];
};

type ConformingPipeline = "control-ui" | "docs-publish" | "native-apps";
type EnglishOnlyReason =
  | "developer-only"
  | "model-authored"
  | "operational-identifier"
  | "upstream-owned"
  | "user-authored";
type NativePlatform = "android" | "apple";

type SurfaceDisposition =
  | {
      id: string;
      owner: string;
      source: string;
      disposition: "adopted";
      catalogArea: string;
      namespace: string;
    }
  | {
      id: string;
      owner: string;
      source: string;
      disposition: "conforming-pipeline";
      pipeline: ConformingPipeline;
    }
  | {
      id: string;
      owner: string;
      source: string;
      disposition: "deferred";
      blockerIssue: number;
      reviewOwner: string;
    }
  | {
      id: string;
      owner: string;
      source: string;
      disposition: "english-only";
      reason: EnglishOnlyReason;
    }
  | {
      id: string;
      owner: string;
      source: string;
      disposition: "platform-constrained";
      pipeline: "native-apps";
      platform: NativePlatform;
    };

type SurfaceRegistry = {
  schemaVersion: 1;
  adapters: readonly SurfaceAdapter[];
  surfaces: readonly SurfaceDisposition[];
};

type PipelineContract = {
  owner: string;
  evidenceCommand: string;
};

const DEFAULT_REGISTRY_PATH = "localization/surfaces.json";
const DEFAULT_CATALOG_REGISTRY_PATH = "localization/catalogs.json";
const PIPELINE_CONTRACTS: Readonly<Record<ConformingPipeline, PipelineContract>> = Object.freeze({
  "control-ui": Object.freeze({ owner: "control-ui", evidenceCommand: "pnpm ui:i18n:verify" }),
  "docs-publish": Object.freeze({
    owner: "docs",
    evidenceCommand: "pnpm docs:check-i18n-glossary",
  }),
  "native-apps": Object.freeze({
    owner: "native-apps",
    evidenceCommand: "pnpm native:i18n:verify",
  }),
});
const ENGLISH_ONLY_REASONS = new Set<EnglishOnlyReason>([
  "developer-only",
  "model-authored",
  "operational-identifier",
  "upstream-owned",
  "user-authored",
]);
const NATIVE_PLATFORMS = new Set<NativePlatform>(["android", "apple"]);

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

function expectRepositoryPath(value: unknown, label: string): string {
  const raw = expectString(value, label);
  const normalized = path.posix.normalize(raw);
  if (
    raw.includes("\\") ||
    /^[A-Za-z]:/u.test(raw) ||
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

function expectPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive issue number`);
  }
  return value as number;
}

function expectReviewOwner(value: unknown, label: string): string {
  const owner = expectString(value, label);
  if (!/^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(owner)) {
    throw new Error(`${label} must be a GitHub @handle`);
  }
  return owner;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).toSorted();
  const wanted = [...expected].toSorted();
  if (actual.join("\0") !== wanted.join("\0")) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicates`);
  }
}

function readPipeline(value: unknown, label: string): ConformingPipeline {
  const pipeline = expectString(value, label);
  if (!Object.hasOwn(PIPELINE_CONTRACTS, pipeline)) {
    throw new Error(`${label} references unsupported conforming pipeline ${pipeline}`);
  }
  return pipeline as ConformingPipeline;
}

function readDisposition(entry: unknown, index: number): SurfaceDisposition {
  const label = `surfaces[${index}]`;
  if (!isRecord(entry)) {
    throw new Error(`${label} must be an object`);
  }
  const disposition = expectString(entry.disposition, `${label}.disposition`);
  const common = {
    id: expectString(entry.id, `${label}.id`),
    owner: expectString(entry.owner, `${label}.owner`),
    source: expectRepositoryPath(entry.source, `${label}.source`),
  };

  if (disposition === "adopted") {
    assertExactKeys(
      entry,
      ["id", "owner", "source", "disposition", "catalogArea", "namespace"],
      label,
    );
    return {
      ...common,
      disposition,
      catalogArea: expectString(entry.catalogArea, `${label}.catalogArea`),
      namespace: expectString(entry.namespace, `${label}.namespace`),
    };
  }
  if (disposition === "conforming-pipeline") {
    assertExactKeys(entry, ["id", "owner", "source", "disposition", "pipeline"], label);
    const pipeline = readPipeline(entry.pipeline, `${label}.pipeline`);
    const contract = PIPELINE_CONTRACTS[pipeline];
    if (contract.owner !== common.owner) {
      throw new Error(
        `${label} owner ${common.owner} does not match pipeline ${pipeline} owner ${contract.owner}`,
      );
    }
    return { ...common, disposition, pipeline };
  }
  if (disposition === "deferred") {
    assertExactKeys(
      entry,
      ["id", "owner", "source", "disposition", "blockerIssue", "reviewOwner"],
      label,
    );
    return {
      ...common,
      disposition,
      blockerIssue: expectPositiveInteger(entry.blockerIssue, `${label}.blockerIssue`),
      reviewOwner: expectReviewOwner(entry.reviewOwner, `${label}.reviewOwner`),
    };
  }
  if (disposition === "english-only") {
    assertExactKeys(entry, ["id", "owner", "source", "disposition", "reason"], label);
    const reason = expectString(entry.reason, `${label}.reason`);
    if (!ENGLISH_ONLY_REASONS.has(reason as EnglishOnlyReason)) {
      throw new Error(`${label}.reason is unsupported: ${reason}`);
    }
    return { ...common, disposition, reason: reason as EnglishOnlyReason };
  }
  if (disposition === "platform-constrained") {
    assertExactKeys(entry, ["id", "owner", "source", "disposition", "pipeline", "platform"], label);
    const pipeline = readPipeline(entry.pipeline, `${label}.pipeline`);
    const platform = expectString(entry.platform, `${label}.platform`);
    if (pipeline !== "native-apps" || !NATIVE_PLATFORMS.has(platform as NativePlatform)) {
      throw new Error(`${label} must use native-apps with platform android or apple`);
    }
    const contract = PIPELINE_CONTRACTS[pipeline];
    if (contract.owner !== common.owner) {
      throw new Error(
        `${label} owner ${common.owner} does not match pipeline ${pipeline} owner ${contract.owner}`,
      );
    }
    return { ...common, disposition, pipeline, platform: platform as NativePlatform };
  }
  throw new Error(`${label}.disposition is unsupported: ${disposition}`);
}

async function canonicalRepositoryRoot(root: string): Promise<string> {
  const canonical = await realpath(root);
  const stats = await lstat(canonical);
  if (!stats.isDirectory()) {
    throw new Error("localization repository root must be a directory");
  }
  return canonical;
}

function resolveInsideRepository(root: string, repoPath: string): string {
  const candidate = path.resolve(root, repoPath);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${repoPath} must resolve inside the repository root`);
  }
  return candidate;
}

async function assertRepositoryEntry(
  root: string,
  repoPath: string,
  kind: "directory" | "file",
  label: string,
): Promise<string> {
  const candidate = resolveInsideRepository(root, repoPath);
  const relative = path.relative(root, candidate);
  let current = root;
  const segments = relative.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      throw new Error(`${label} is missing: ${repoPath}`, { cause: error });
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} traverses symbolic link ${repoPath}`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error(`${label} has a non-directory parent: ${repoPath}`);
    }
    if (index === segments.length - 1) {
      const valid = kind === "directory" ? stats.isDirectory() : stats.isFile();
      if (!valid) {
        throw new Error(`${label} is not a ${kind}: ${repoPath}`);
      }
    }
  }
  return candidate;
}

async function readRegistry(root: string, registryPath: string): Promise<SurfaceRegistry> {
  const normalizedPath = expectRepositoryPath(registryPath, "surface registry path");
  const filePath = await assertRepositoryEntry(root, normalizedPath, "file", "surface registry");
  const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
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
  assertExactKeys(raw, ["schemaVersion", "adapters", "surfaces"], "surface registry");

  const adapters = raw.adapters.map((entry, index): SurfaceAdapter => {
    const label = `adapters[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`${label} must be an object`);
    }
    assertExactKeys(entry, ["id", "owner", "roots", "extensions"], label);
    const roots = expectStringArray(entry.roots, `${label}.roots`).map((value, rootIndex) =>
      expectRepositoryPath(value, `${label}.roots[${rootIndex}]`),
    );
    const extensions = expectStringArray(entry.extensions, `${label}.extensions`).map(
      (value, extensionIndex) => expectExtension(value, `${label}.extensions[${extensionIndex}]`),
    );
    assertUnique(roots, `${label}.roots`);
    assertUnique(extensions, `${label}.extensions`);
    return {
      id: expectString(entry.id, `${label}.id`),
      owner: expectString(entry.owner, `${label}.owner`),
      roots,
      extensions,
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
  assertUnique(
    surfaces
      .filter((surface) => surface.disposition === "adopted")
      .map((surface) => surface.catalogArea),
    "adopted catalog areas",
  );
  return { schemaVersion: 1, adapters, surfaces };
}

async function discoverRoot(
  root: string,
  repoPath: string,
  adapter: SurfaceAdapter,
  generatedTargets: ReadonlySet<string>,
  discovered: Map<string, string>,
): Promise<void> {
  const directory = resolveInsideRepository(root, repoPath);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`adapter ${adapter.id} cannot read declared root ${repoPath}`, {
      cause: error,
    });
  }
  for (const entry of entries.toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const childPath = path.posix.join(repoPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`adapter ${adapter.id} encountered symbolic link ${childPath}`);
    }
    if (entry.isDirectory()) {
      await discoverRoot(root, childPath, adapter, generatedTargets, discovered);
      continue;
    }
    if (!entry.isFile() || !adapter.extensions.includes(path.posix.extname(entry.name))) {
      continue;
    }
    if (generatedTargets.has(childPath)) {
      continue;
    }
    const previousAdapter = discovered.get(childPath);
    if (previousAdapter) {
      throw new Error(`${childPath} is discovered by both ${previousAdapter} and ${adapter.id}`);
    }
    discovered.set(childPath, adapter.id);
  }
}

async function discoverSurfaces(
  root: string,
  adapters: readonly SurfaceAdapter[],
  generatedTargets: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const discovered = new Map<string, string>();
  for (const adapter of adapters) {
    for (const rootPath of adapter.roots) {
      await assertRepositoryEntry(
        root,
        rootPath,
        "directory",
        `adapter ${adapter.id} declared root`,
      );
      await discoverRoot(root, rootPath, adapter, generatedTargets, discovered);
    }
  }
  return discovered;
}

function validateCatalogBijection(
  catalogAreas: readonly CatalogArea[],
  surfaces: readonly SurfaceDisposition[],
): void {
  const adoptedByArea = new Map(
    surfaces
      .filter((surface) => surface.disposition === "adopted")
      .map((surface) => [surface.catalogArea, surface]),
  );
  const areasById = new Map(catalogAreas.map((area) => [area.id, area]));

  for (const surface of surfaces) {
    if (surface.disposition !== "adopted") {
      continue;
    }
    const area = areasById.get(surface.catalogArea);
    if (!area) {
      throw new Error(
        `surface ${surface.id} references unknown catalog area ${surface.catalogArea}`,
      );
    }
  }

  for (const area of catalogAreas) {
    const surface = adoptedByArea.get(area.id);
    if (!surface) {
      throw new Error(`catalog area ${area.id} has no adopted surface disposition`);
    }
    if (surface.source !== area.source) {
      throw new Error(
        `surface ${surface.id} source ${surface.source} does not match catalog area ${area.id} source ${area.source}`,
      );
    }
    if (surface.owner !== area.owner) {
      throw new Error(
        `surface ${surface.id} owner ${surface.owner} does not match catalog area ${area.id} owner ${area.owner}`,
      );
    }
    if (surface.namespace !== area.namespace) {
      throw new Error(
        `surface ${surface.id} namespace ${surface.namespace} does not match catalog area ${area.id} namespace ${area.namespace}`,
      );
    }
  }
}

export async function checkSurfaceDispositions(
  options: { root?: string; registryPath?: string; catalogRegistryPath?: string } = {},
): Promise<number> {
  const root = await canonicalRepositoryRoot(options.root ?? process.cwd());
  const registry = await readRegistry(root, options.registryPath ?? DEFAULT_REGISTRY_PATH);
  const catalogRegistry = await loadCatalogRegistry({
    root,
    registryPath: options.catalogRegistryPath ?? DEFAULT_CATALOG_REGISTRY_PATH,
  });
  const generatedTargets = new Set(
    catalogRegistry.areas.flatMap((area) => area.targets.map((target) => target.path)),
  );
  const discovered = await discoverSurfaces(root, registry.adapters, generatedTargets);
  for (const target of generatedTargets) {
    await assertRepositoryEntry(root, target, "file", "generated catalog target");
  }
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
  validateCatalogBijection(catalogRegistry.areas, registry.surfaces);
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
