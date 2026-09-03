/** Immutable package generations and atomic selector state for managed updates. */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "./errors.js";
import { updateGenerationSelectionSchema } from "./update-generation-contract-schema.js";
import type {
  UpdateGenerationDescriptor,
  UpdateGenerationManifest,
  UpdateGenerationSelection,
} from "./update-generation-contract.js";
import {
  captureUpdateGenerationManifest,
  removeUpdateGenerationTree,
  sealUpdateGenerationTree,
  syncUpdateGenerationPath,
  syncUpdateGenerationTree,
  updateGenerationPathIsEqualOrNested,
} from "./update-generation-manifest.js";

export { captureUpdateGenerationManifest };

const GENERATION_ID = /^[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SELECTOR_FILE_NAME = "selector.json";
const GENERATIONS_DIRECTORY_NAME = "generations";
export const UPDATE_GENERATION_LAUNCHER_FILE_NAME = "launcher.mjs";

type UpdateGenerationNamespace = {
  root: string;
  generationsRoot: string | null;
};

export type MaterializedUpdateGeneration = {
  generation: UpdateGenerationDescriptor;
  generationRoot: string;
  payloadRoot: string;
};

export type ResolvedUpdateGeneration = {
  selectorPath: string;
  selection: UpdateGenerationSelection;
  generationRoot: string;
  payloadRoot: string;
};

export const UPDATE_GENERATION_LAUNCHER_SOURCE = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const launcherRoot = path.dirname(fileURLToPath(import.meta.url));
const selectorPath = path.join(launcherRoot, "selector.json");
let selector;
try {
  const selectorStat = fs.lstatSync(selectorPath);
  if (!selectorStat.isFile() || selectorStat.isSymbolicLink() || selectorStat.size > 8192) {
    throw new Error("selector is not a bounded regular file");
  }
  selector = JSON.parse(fs.readFileSync(selectorPath, "utf8"));
} catch (error) {
  throw new Error(\`Unable to read OpenClaw generation selector at \${selectorPath}\`, { cause: error });
}
if (
  selector?.formatVersion !== 1 ||
  !/^[a-f0-9]{32}$/.test(selector.generationId) ||
  !/^[a-f0-9]{64}$/.test(selector.manifestSha256) ||
  typeof selector.entrypointRelativePath !== "string"
) {
  throw new Error("Invalid OpenClaw generation selector");
}
const relativeEntrypoint = selector.entrypointRelativePath.replaceAll("\\\\", "/");
if (
  !relativeEntrypoint ||
  relativeEntrypoint.startsWith("/") ||
  new RegExp("^[A-Za-z]:/").test(relativeEntrypoint) ||
  relativeEntrypoint.split("/").some((part) => part === "" || part === "." || part === "..")
) {
  throw new Error("Invalid OpenClaw generation entrypoint");
}
const generationRoot = path.join(
  launcherRoot,
  "generations",
  selector.generationId,
);
const payloadRoot = path.join(generationRoot, "payload");
for (const ownedDirectory of [generationRoot, payloadRoot]) {
  const stat = fs.lstatSync(ownedDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(\`Selected OpenClaw generation path is not an owned directory: \${ownedDirectory}\`);
  }
}
const entrypoint = path.join(
  payloadRoot,
  ...relativeEntrypoint.split("/"),
);
const entrypointStat = fs.lstatSync(entrypoint);
if (!entrypointStat.isFile() || entrypointStat.isSymbolicLink()) {
  throw new Error(\`Selected OpenClaw entrypoint is not a file: \${entrypoint}\`);
}
process.argv[1] = entrypoint;
await import(pathToFileURL(entrypoint).href);
`;

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    path.win32.isAbsolute(value) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError(`Expected a safe relative path, received ${value}`);
  }
  return normalized;
}

function assertGenerationId(generationId: string): void {
  if (!GENERATION_ID.test(generationId)) {
    throw new TypeError(`Invalid update generation id: ${generationId}`);
  }
}

function assertManifest(manifest: UpdateGenerationManifest): void {
  if (
    manifest.algorithm !== "sha256" ||
    !SHA256.test(manifest.digest) ||
    !Number.isSafeInteger(manifest.entryCount) ||
    manifest.entryCount < 0 ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    manifest.totalBytes < 0
  ) {
    throw new TypeError("Invalid update generation manifest");
  }
}

function assertSelection(selection: UpdateGenerationSelection): void {
  if (selection.formatVersion !== 1) {
    throw new TypeError("Unsupported update generation selector version");
  }
  assertGenerationId(selection.generationId);
  if (!SHA256.test(selection.manifestSha256)) {
    throw new TypeError("Invalid update generation selector digest");
  }
  normalizeRelativePath(selection.entrypointRelativePath);
}

function manifestsEqual(left: UpdateGenerationManifest, right: UpdateGenerationManifest): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.digest === right.digest &&
    left.entryCount === right.entryCount &&
    left.totalBytes === right.totalBytes
  );
}

function requireMatchingManifest(params: {
  expected: UpdateGenerationManifest;
  actual: UpdateGenerationManifest;
  label: string;
}): void {
  if (!manifestsEqual(params.expected, params.actual)) {
    throw new Error(
      `${params.label} changed: expected ${params.expected.digest}, found ${params.actual.digest}`,
    );
  }
}

function generationPaths(
  namespace: UpdateGenerationNamespace,
  generationId: string,
): {
  generationsRoot: string;
  generationRoot: string;
  payloadRoot: string;
} {
  assertGenerationId(generationId);
  const generationsRoot = namespace.generationsRoot;
  if (!generationsRoot) {
    throw new Error(`Update generation namespace has no generations directory: ${namespace.root}`);
  }
  const generationRoot = path.join(generationsRoot, generationId);
  return { generationsRoot, generationRoot, payloadRoot: path.join(generationRoot, "payload") };
}

async function resolveUpdateGenerationNamespace(params: {
  namespaceRoot: string;
  create: boolean;
  requireGenerations: boolean;
}): Promise<UpdateGenerationNamespace | null> {
  const requestedRoot = path.resolve(params.namespaceRoot);
  if (params.create) {
    await fs.mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  }
  const rootStat = await fs.lstat(requestedRoot).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (!rootStat) {
    return null;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Invalid update generation namespace: ${requestedRoot}`);
  }
  const root = await fs.realpath(requestedRoot);
  const requestedGenerationsRoot = path.join(root, GENERATIONS_DIRECTORY_NAME);
  if (params.create) {
    await fs.mkdir(requestedGenerationsRoot, { mode: 0o700 }).catch((error: unknown) => {
      if (!hasErrnoCode(error, "EEXIST")) {
        throw error;
      }
    });
  }
  const generationsStat = await fs.lstat(requestedGenerationsRoot).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (!generationsStat) {
    if (params.requireGenerations) {
      throw new Error(`Update generation namespace is incomplete: ${requestedGenerationsRoot}`);
    }
    return { root, generationsRoot: null };
  }
  if (!generationsStat.isDirectory() || generationsStat.isSymbolicLink()) {
    throw new Error(`Invalid update generations directory: ${requestedGenerationsRoot}`);
  }
  const generationsRoot = await fs.realpath(requestedGenerationsRoot);
  if (path.dirname(generationsRoot) !== root) {
    throw new Error(`Update generations directory escapes its namespace: ${generationsRoot}`);
  }
  return { root, generationsRoot };
}

export function createUpdateGenerationId(): string {
  return randomBytes(16).toString("hex");
}

export function resolveUpdateGenerationSelectorPath(namespaceRoot: string): string {
  return path.join(path.resolve(namespaceRoot), SELECTOR_FILE_NAME);
}

export async function materializeUpdateGeneration(params: {
  namespaceRoot: string;
  sourceRoot: string;
  generationId: string;
  expectedManifest: UpdateGenerationManifest;
  packageVersion: string;
  entrypointRelativePath: string;
}): Promise<MaterializedUpdateGeneration> {
  assertGenerationId(params.generationId);
  assertManifest(params.expectedManifest);
  const entrypointRelativePath = normalizeRelativePath(params.entrypointRelativePath);
  if (!params.packageVersion.trim()) {
    throw new TypeError("Update generation package version is required");
  }
  const namespaceRoot = path.resolve(params.namespaceRoot);
  const sourceRoot = await fs.realpath(path.resolve(params.sourceRoot));
  if (updateGenerationPathIsEqualOrNested(sourceRoot, namespaceRoot)) {
    throw new Error("Update generation namespace cannot be inside its source");
  }
  const namespace = await resolveUpdateGenerationNamespace({
    namespaceRoot,
    create: true,
    requireGenerations: true,
  });
  if (!namespace) {
    throw new Error(`Unable to create update generation namespace: ${namespaceRoot}`);
  }
  const paths = generationPaths(namespace, params.generationId);
  const generationsRootReal = paths.generationsRoot;
  if (
    updateGenerationPathIsEqualOrNested(sourceRoot, generationsRootReal) ||
    updateGenerationPathIsEqualOrNested(generationsRootReal, sourceRoot)
  ) {
    throw new Error("Update generation source and destination must be disjoint");
  }

  const existing = await fs.lstat(paths.generationRoot).catch(() => null);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`Update generation path is not a directory: ${paths.generationRoot}`);
    }
    const manifest = await captureUpdateGenerationManifest(paths.payloadRoot);
    requireMatchingManifest({
      expected: params.expectedManifest,
      actual: manifest,
      label: "Existing update generation",
    });
    await assertGenerationEntrypoint(paths.payloadRoot, entrypointRelativePath);
    return {
      generation: {
        formatVersion: 1,
        generationId: params.generationId,
        manifestSha256: manifest.digest,
        entrypointRelativePath,
        packageVersion: params.packageVersion,
      },
      generationRoot: paths.generationRoot,
      payloadRoot: paths.payloadRoot,
    };
  }

  const sourceBefore = await captureUpdateGenerationManifest(sourceRoot);
  requireMatchingManifest({
    expected: params.expectedManifest,
    actual: sourceBefore,
    label: "Update generation source",
  });
  const incomingRoot = path.join(
    paths.generationsRoot,
    `.incoming-${params.generationId}-${randomBytes(8).toString("hex")}`,
  );
  const incomingPayload = path.join(incomingRoot, "payload");
  try {
    await fs.mkdir(incomingRoot, { mode: 0o700 });
    await fs.cp(sourceRoot, incomingPayload, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: false,
      verbatimSymlinks: true,
    });
    const [sourceAfter, destination] = await Promise.all([
      captureUpdateGenerationManifest(sourceRoot),
      captureUpdateGenerationManifest(incomingPayload),
    ]);
    requireMatchingManifest({
      expected: params.expectedManifest,
      actual: sourceAfter,
      label: "Update generation source during copy",
    });
    requireMatchingManifest({
      expected: params.expectedManifest,
      actual: destination,
      label: "Copied update generation",
    });
    await sealUpdateGenerationTree(incomingPayload);
    const sealed = await captureUpdateGenerationManifest(incomingPayload);
    requireMatchingManifest({
      expected: params.expectedManifest,
      actual: sealed,
      label: "Sealed update generation",
    });
    await assertGenerationEntrypoint(incomingPayload, entrypointRelativePath);
    await syncUpdateGenerationTree(incomingRoot);
    await fs.rename(incomingRoot, paths.generationRoot);
    await syncUpdateGenerationPath(paths.generationsRoot);
    return {
      generation: {
        formatVersion: 1,
        generationId: params.generationId,
        manifestSha256: sealed.digest,
        entrypointRelativePath,
        packageVersion: params.packageVersion,
      },
      generationRoot: paths.generationRoot,
      payloadRoot: paths.payloadRoot,
    };
  } catch (error) {
    await removeUpdateGenerationTree(incomingRoot).catch(() => undefined);
    throw error;
  }
}

function selectionsEqual(
  left: UpdateGenerationSelection | null,
  right: UpdateGenerationSelection | null,
): boolean {
  return (
    left?.formatVersion === right?.formatVersion &&
    left?.generationId === right?.generationId &&
    left?.manifestSha256 === right?.manifestSha256 &&
    left?.entrypointRelativePath === right?.entrypointRelativePath
  );
}

async function readUpdateGenerationSelectorAtRoot(
  namespaceRoot: string,
): Promise<UpdateGenerationSelection | null> {
  const selectorPath = path.join(namespaceRoot, SELECTOR_FILE_NAME);
  const stat = await fs.lstat(selectorPath).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (!stat) {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) {
    throw new Error(`Invalid update generation selector file: ${selectorPath}`);
  }
  const parsed: unknown = JSON.parse(await fs.readFile(selectorPath, "utf8"));
  const candidate = updateGenerationSelectionSchema.parse(parsed);
  assertSelection(candidate);
  return {
    formatVersion: 1,
    generationId: candidate.generationId,
    manifestSha256: candidate.manifestSha256,
    entrypointRelativePath: normalizeRelativePath(candidate.entrypointRelativePath),
  };
}

export async function readUpdateGenerationSelector(
  namespaceRoot: string,
): Promise<UpdateGenerationSelection | null> {
  const namespace = await resolveUpdateGenerationNamespace({
    namespaceRoot,
    create: false,
    requireGenerations: false,
  });
  return namespace ? await readUpdateGenerationSelectorAtRoot(namespace.root) : null;
}

async function assertGenerationEntrypoint(
  payloadRoot: string,
  entrypointRelativePath: string,
): Promise<string> {
  const entrypoint = path.join(payloadRoot, ...entrypointRelativePath.split("/"));
  const entrypointStat = await fs.lstat(entrypoint).catch(() => null);
  if (!entrypointStat?.isFile() || entrypointStat.isSymbolicLink()) {
    throw new Error(`Selected update generation entrypoint is unavailable: ${entrypoint}`);
  }
  return entrypoint;
}

export async function resolveSelectedUpdateGeneration(params: {
  namespaceRoot: string;
  verifyManifest?: boolean;
}): Promise<ResolvedUpdateGeneration | null> {
  const namespace = await resolveUpdateGenerationNamespace({
    namespaceRoot: params.namespaceRoot,
    create: false,
    requireGenerations: false,
  });
  if (!namespace) {
    return null;
  }
  const selection = await readUpdateGenerationSelectorAtRoot(namespace.root);
  if (!selection) {
    return null;
  }
  if (!namespace.generationsRoot) {
    throw new Error(`Selected update generation namespace is incomplete: ${namespace.root}`);
  }
  const paths = generationPaths(namespace, selection.generationId);
  const stat = await fs.lstat(paths.payloadRoot).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Selected update generation is unavailable: ${paths.payloadRoot}`);
  }
  if (params.verifyManifest) {
    const manifest = await captureUpdateGenerationManifest(paths.payloadRoot);
    if (manifest.digest !== selection.manifestSha256) {
      throw new Error(`Selected update generation manifest mismatch: ${paths.payloadRoot}`);
    }
  }
  await assertGenerationEntrypoint(paths.payloadRoot, selection.entrypointRelativePath);
  return {
    selectorPath: path.join(namespace.root, SELECTOR_FILE_NAME),
    selection,
    generationRoot: paths.generationRoot,
    payloadRoot: paths.payloadRoot,
  };
}

export async function replaceUpdateGenerationSelector(params: {
  namespaceRoot: string;
  expected: UpdateGenerationSelection | null;
  next: UpdateGenerationSelection;
}): Promise<void> {
  assertSelection(params.next);
  const namespace = await resolveUpdateGenerationNamespace({
    namespaceRoot: params.namespaceRoot,
    create: true,
    requireGenerations: true,
  });
  if (!namespace) {
    throw new Error(`Unable to create update generation namespace: ${params.namespaceRoot}`);
  }
  const paths = generationPaths(namespace, params.next.generationId);
  const manifest = await captureUpdateGenerationManifest(paths.payloadRoot);
  if (manifest.digest !== params.next.manifestSha256) {
    throw new Error("Refusing to select an update generation with a mismatched manifest");
  }
  await assertGenerationEntrypoint(paths.payloadRoot, params.next.entrypointRelativePath);
  const current = await readUpdateGenerationSelectorAtRoot(namespace.root);
  if (!selectionsEqual(current, params.expected)) {
    throw new Error("Update generation selector changed before replacement");
  }
  const selectorPath = path.join(namespace.root, SELECTOR_FILE_NAME);
  const temporaryPath = path.join(
    namespace.root,
    `.selector-${randomBytes(8).toString("hex")}.tmp`,
  );
  const contents = `${JSON.stringify(params.next)}\n`;
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const rechecked = await readUpdateGenerationSelectorAtRoot(namespace.root);
    if (!selectionsEqual(rechecked, params.expected)) {
      throw new Error("Update generation selector changed during replacement");
    }
    // Regular-file rename is the only commit point on POSIX and Windows. Never
    // unlink the prior selector as a fallback: failure must retain old routing.
    await fs.rename(temporaryPath, selectorPath);
    await syncUpdateGenerationPath(namespace.root);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function ensureUpdateGenerationLauncher(namespaceRoot: string): Promise<string> {
  const namespace = await resolveUpdateGenerationNamespace({
    namespaceRoot,
    create: true,
    requireGenerations: true,
  });
  if (!namespace) {
    throw new Error(`Unable to create update generation namespace: ${namespaceRoot}`);
  }
  const root = namespace.root;
  const launcherPath = path.join(root, UPDATE_GENERATION_LAUNCHER_FILE_NAME);
  const existingStat = await fs.lstat(launcherPath).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (existingStat) {
    if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
      throw new Error(`Refusing to replace an invalid generation launcher: ${launcherPath}`);
    }
    const existing = await fs.readFile(launcherPath, "utf8");
    if (existing !== UPDATE_GENERATION_LAUNCHER_SOURCE) {
      throw new Error(`Refusing to replace an unknown generation launcher: ${launcherPath}`);
    }
    await fs.chmod(launcherPath, 0o500);
    return launcherPath;
  }
  const temporaryPath = path.join(root, `.launcher-${randomBytes(8).toString("hex")}.tmp`);
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o500);
    try {
      await handle.writeFile(UPDATE_GENERATION_LAUNCHER_SOURCE, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, launcherPath);
    await syncUpdateGenerationPath(root);
    return launcherPath;
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    const raced = await fs.readFile(launcherPath, "utf8").catch(() => null);
    if (raced === UPDATE_GENERATION_LAUNCHER_SOURCE) {
      return launcherPath;
    }
    throw error;
  }
}

/**
 * Remove one ledger-authorized obsolete generation.
 *
 * Call only while the authoritative ledger serializes this namespace. The
 * selector check is defense in depth; it is not a replacement for that lease.
 */
export async function removeObsoleteUpdateGeneration(params: {
  namespaceRoot: string;
  generationId: string;
  protectedGenerationIds: string[];
}): Promise<boolean> {
  assertGenerationId(params.generationId);
  if (new Set(params.protectedGenerationIds).has(params.generationId)) {
    throw new Error(`Refusing to remove protected update generation ${params.generationId}`);
  }
  const namespace = await resolveUpdateGenerationNamespace({
    namespaceRoot: params.namespaceRoot,
    create: false,
    requireGenerations: true,
  });
  if (!namespace) {
    return false;
  }
  const selected = await readUpdateGenerationSelectorAtRoot(namespace.root);
  if (selected?.generationId === params.generationId) {
    throw new Error(`Refusing to remove active update generation ${params.generationId}`);
  }
  const paths = generationPaths(namespace, params.generationId);
  const existing = await fs.lstat(paths.generationRoot).catch(() => null);
  if (!existing) {
    return false;
  }
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw new Error(`Refusing to remove invalid update generation ${paths.generationRoot}`);
  }
  const retiredRoot = path.join(
    paths.generationsRoot,
    `.retired-${params.generationId}-${randomBytes(8).toString("hex")}`,
  );
  await fs.rename(paths.generationRoot, retiredRoot);
  const rechecked = await readUpdateGenerationSelectorAtRoot(namespace.root);
  if (rechecked?.generationId === params.generationId) {
    await fs.rename(retiredRoot, paths.generationRoot);
    throw new Error(`Active update generation changed during cleanup: ${params.generationId}`);
  }
  await removeUpdateGenerationTree(retiredRoot);
  await syncUpdateGenerationPath(paths.generationsRoot);
  return true;
}
