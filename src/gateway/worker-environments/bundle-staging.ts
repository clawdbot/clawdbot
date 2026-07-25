import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { collectPackageDistInventory } from "../../infra/package-dist-inventory.js";

// Host node_modules can contain platform-native code and is not portable to a leased box.
// The bundle ships dist, a pruned package.json, and vendored copies of dist-external
// workspace packages; bootstrap installs production dependencies on the box with
// scripts disabled, mirroring the npm channel.
const WORKER_PACKAGE_LIFECYCLE_FIELDS = ["devDependencies", "scripts", "pnpm"] as const;
const CONTROL_UI_DIST_PREFIX = "dist/control-ui/";

export type WorkerBundleManifestEntry = {
  path: string;
  mode: number;
  size: number;
  sha256: string;
};

export function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readManifestDependencies(parsed: Record<string, unknown>): Record<string, string> {
  return parsed.dependencies && typeof parsed.dependencies === "object"
    ? (parsed.dependencies as Record<string, string>)
    : {};
}

function withoutLifecycleFields(parsed: Record<string, unknown>): {
  pruned: Record<string, unknown>;
  prunedFieldCount: number;
} {
  const prunedFields = WORKER_PACKAGE_LIFECYCLE_FIELDS.filter((key) => key in parsed);
  const pruned = { ...parsed };
  for (const key of prunedFields) {
    delete pruned[key];
  }
  return { pruned, prunedFieldCount: prunedFields.length };
}

function serializePackageManifest(parsed: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

// `workspace:` specs cannot resolve on the box: packages bundled into dist are dropped,
// while dist-external workspace packages are rewritten to relative file: specs that point
// at their vendored copies so `npm install` on the box resolves them without a registry.
function pruneWorkerPackageManifest(
  contents: Buffer,
  vendoredDirsByName: ReadonlyMap<string, string>,
): Buffer {
  const parsed = JSON.parse(contents.toString("utf8")) as Record<string, unknown>;
  const dependencies = readManifestDependencies(parsed);
  let workspaceSpecCount = 0;
  const portable: Record<string, string> = {};
  for (const [name, spec] of Object.entries(dependencies)) {
    if (!spec.startsWith("workspace:")) {
      portable[name] = spec;
      continue;
    }
    workspaceSpecCount += 1;
    const vendorDir = vendoredDirsByName.get(name);
    if (vendorDir) {
      portable[name] = `file:./${vendorDir}`;
    }
  }
  const { pruned, prunedFieldCount } = withoutLifecycleFields(parsed);
  if (prunedFieldCount === 0 && workspaceSpecCount === 0) {
    // Released package manifests are already portable; keep bytes (and hashes) stable.
    return contents;
  }
  pruned.dependencies = portable;
  return serializePackageManifest(pruned);
}

// Vendored workspace manifests keep their registry dependencies but never ship
// lifecycle scripts or dev-only fields.
function pruneVendoredPackageManifest(contents: Buffer): Buffer {
  const parsed = JSON.parse(contents.toString("utf8")) as Record<string, unknown>;
  const { pruned, prunedFieldCount } = withoutLifecycleFields(parsed);
  return prunedFieldCount === 0 ? contents : serializePackageManifest(pruned);
}

function normalizePortableMode(mode: number, relativePath: string): number {
  return relativePath === "openclaw.mjs" || (mode & 0o111) !== 0 ? 0o700 : 0o600;
}

type StagedFileSource = {
  sourcePath: string;
  expectedRealPath: string;
  stagedPath: string;
  transform?: (contents: Buffer) => Buffer;
};

async function stageFileEntry(
  stagingRoot: string,
  source: StagedFileSource,
): Promise<{ entry: WorkerBundleManifestEntry; contents: Buffer }> {
  const { sourcePath, expectedRealPath, stagedPath } = source;
  const sourceRealPath = await fs.realpath(sourcePath);
  if (sourceRealPath !== expectedRealPath) {
    throw new Error(`Unsafe worker bundle path: ${stagedPath}`);
  }
  const stats = await fs.lstat(sourcePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Unsafe worker bundle path: ${stagedPath}`);
  }
  const handle = await fs.open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let contents: Buffer;
  let mode: number;
  try {
    const openedStats = await handle.stat();
    const currentStats = await fs.lstat(sourcePath);
    const currentRealPath = await fs.realpath(sourcePath);
    if (
      !openedStats.isFile() ||
      currentStats.isSymbolicLink() ||
      !currentStats.isFile() ||
      currentRealPath !== expectedRealPath ||
      currentStats.dev !== openedStats.dev ||
      currentStats.ino !== openedStats.ino
    ) {
      throw new Error(`Worker bundle path changed while packaging: ${stagedPath}`);
    }
    contents = await handle.readFile();
    if (source.transform) {
      contents = source.transform(contents);
    }
    mode = normalizePortableMode(openedStats.mode, stagedPath);
  } finally {
    await handle.close();
  }
  const stagedFilePath = path.join(stagingRoot, ...stagedPath.split("/"));
  await fs.mkdir(path.dirname(stagedFilePath), { recursive: true });
  await fs.writeFile(stagedFilePath, contents, { mode });
  await fs.chmod(stagedFilePath, mode);
  return {
    entry: {
      path: stagedPath,
      mode,
      size: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    },
    contents,
  };
}

async function stageManifestEntry(
  sourceRoot: string,
  sourceRootRealPath: string,
  stagingRoot: string,
  relativePath: string,
  transform?: (contents: Buffer) => Buffer,
): Promise<{ entry: WorkerBundleManifestEntry; contents: Buffer }> {
  return await stageFileEntry(stagingRoot, {
    sourcePath: path.join(sourceRoot, relativePath),
    expectedRealPath: path.resolve(sourceRootRealPath, ...relativePath.split("/")),
    stagedPath: relativePath,
    transform,
  });
}

// tsdown keeps some @openclaw workspace packages external of dist (never-bundle list),
// so shipped dist imports them at runtime; scan staged bytes for those specifiers to
// know which workspace builds must ride along in the bundle.
const OPENCLAW_IMPORT_SPECIFIER_PATTERN =
  /["'`](@openclaw\/[a-z0-9-]+)(?:\/[A-Za-z0-9./_-]+)?["'`]/gu;

function collectOpenclawImportSpecifiers(
  relativePath: string,
  contents: Buffer,
  into: Set<string>,
): void {
  if (!/\.(?:cjs|js|mjs)$/u.test(relativePath)) {
    return;
  }
  for (const match of contents.toString("utf8").matchAll(OPENCLAW_IMPORT_SPECIFIER_PATTERN)) {
    const packageName = match[1];
    if (packageName) {
      into.add(packageName);
    }
  }
}

async function readWorkspaceDependencyNames(sourceRoot: string): Promise<Set<string>> {
  const raw = await fs.readFile(path.join(sourceRoot, "package.json"), "utf8");
  const dependencies = readManifestDependencies(JSON.parse(raw) as Record<string, unknown>);
  const names = Object.entries(dependencies)
    .filter(([, spec]) => spec.startsWith("workspace:"))
    .map(([name]) => name);
  return new Set(names);
}

async function collectVendoredPackageFiles(
  packageName: string,
  vendorRealRoot: string,
): Promise<string[]> {
  const files = ["package.json"];
  const shrinkwrapStats = await fs
    .lstat(path.join(vendorRealRoot, "npm-shrinkwrap.json"))
    .catch(() => undefined);
  if (shrinkwrapStats?.isFile()) {
    files.push("npm-shrinkwrap.json");
  }
  const walk = async (relativeDir: string): Promise<void> => {
    const dirents = await fs.readdir(path.join(vendorRealRoot, ...relativeDir.split("/")), {
      withFileTypes: true,
    });
    for (const dirent of dirents) {
      const relativePath = `${relativeDir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        await walk(relativePath);
      } else if (dirent.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`Unsafe worker bundle vendor path: ${packageName}/${relativePath}`);
      }
    }
  };
  try {
    await walk("dist");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Workspace dependency ${packageName} referenced by the worker dist has no built dist directory at ${vendorRealRoot}`,
        { cause: error },
      );
    }
    throw error;
  }
  return files.toSorted(comparePaths);
}

async function stageVendoredWorkspacePackages(params: {
  sourceRoot: string;
  stagingRoot: string;
  packageNames: readonly string[];
}): Promise<{ entries: WorkerBundleManifestEntry[]; vendoredDirsByName: Map<string, string> }> {
  const entries: WorkerBundleManifestEntry[] = [];
  const vendoredDirsByName = new Map<string, string>();
  for (const packageName of [...params.packageNames].toSorted(comparePaths)) {
    const linkedPath = path.join(params.sourceRoot, "node_modules", ...packageName.split("/"));
    let vendorRealRoot: string;
    try {
      // pnpm links workspace packages into node_modules; realpath lands on the real
      // package dir, which is the staging source for its built dist.
      vendorRealRoot = await fs.realpath(linkedPath);
    } catch (error) {
      throw new Error(
        `Worker bundle cannot resolve workspace dependency ${packageName} referenced by dist; expected an installed package at ${linkedPath}`,
        { cause: error },
      );
    }
    const vendorDir = `vendor/${packageName.replace(/^@/u, "").replaceAll("/", "-")}`;
    for (const relativePath of await collectVendoredPackageFiles(packageName, vendorRealRoot)) {
      const { entry } = await stageFileEntry(params.stagingRoot, {
        sourcePath: path.join(vendorRealRoot, ...relativePath.split("/")),
        expectedRealPath: path.resolve(vendorRealRoot, ...relativePath.split("/")),
        stagedPath: `${vendorDir}/${relativePath}`,
        transform: relativePath === "package.json" ? pruneVendoredPackageManifest : undefined,
      });
      entries.push(entry);
    }
    vendoredDirsByName.set(packageName, vendorDir);
  }
  return { entries, vendoredDirsByName };
}

export async function collectWorkerBundleManifest(
  sourceRoot: string,
  stagingRoot: string,
): Promise<WorkerBundleManifestEntry[]> {
  const sourceRootRealPath = await fs.realpath(sourceRoot);
  // Control UI assets are built lazily after the Gateway starts and never execute on workers.
  // Excluding them keeps worker identity stable across that startup race.
  const distFiles = (await collectPackageDistInventory(sourceRoot)).filter(
    (relativePath) => !relativePath.startsWith(CONTROL_UI_DIST_PREFIX),
  );
  if (distFiles.length === 0) {
    throw new Error(
      `OpenClaw worker bundle has no packaged dist files; build the running package at ${sourceRoot}`,
    );
  }
  const referencedPackages = new Set<string>();
  const entries: WorkerBundleManifestEntry[] = [];
  for (const relativePath of ["openclaw.mjs", ...distFiles].toSorted(comparePaths)) {
    const { entry, contents } = await stageManifestEntry(
      sourceRoot,
      sourceRootRealPath,
      stagingRoot,
      relativePath,
    );
    collectOpenclawImportSpecifiers(relativePath, contents, referencedPackages);
    entries.push(entry);
  }
  const workspaceDependencyNames = await readWorkspaceDependencyNames(sourceRoot);
  const vendored = await stageVendoredWorkspacePackages({
    sourceRoot,
    stagingRoot,
    packageNames: [...workspaceDependencyNames].filter((name) => referencedPackages.has(name)),
  });
  entries.push(...vendored.entries);
  // The shipped root manifest is derived after the dist scan so vendored workspace deps
  // can be rewritten to their staged file: locations.
  const manifest = await stageManifestEntry(
    sourceRoot,
    sourceRootRealPath,
    stagingRoot,
    "package.json",
    (contents) => pruneWorkerPackageManifest(contents, vendored.vendoredDirsByName),
  );
  entries.push(manifest.entry);
  return entries.toSorted((left, right) => comparePaths(left.path, right.path));
}
