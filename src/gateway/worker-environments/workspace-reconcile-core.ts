import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError, root as openFsSafeRoot } from "../../infra/fs-safe.js";
import {
  MAX_RECONCILIATION_ENTRIES,
  MAX_RECONCILIATION_TOTAL_BYTES,
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";
import {
  reconciliationDirectories,
  reconciliationEntries,
} from "./workspace-reconcile-derived-paths.js";
import {
  directoryContainsOnlyDerivedWorkspaceEntries,
  entryMatches,
  localPath,
  readWorkspaceFileSnapshot,
} from "./workspace-reconcile-fs.js";
export {
  MAX_RECONCILIATION_ENTRIES,
  MAX_RECONCILIATION_FILE_BYTES,
  MAX_RECONCILIATION_TOTAL_BYTES,
  parseWorkerWorkspaceManifest,
  parseWorkerWorkspaceReconciliationPlan,
  serializeWorkerWorkspaceReconciliationPlan,
  type WorkerWorkspaceReconciliationJournal,
  type WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-manifest.js";

const MAX_RECONCILIATION_PATH_BYTES = 64 * 1024 * 1024;

export class ConcurrentWorkspacePathError extends Error {}

type WorkspaceNode =
  | WorkerWorkspaceManifestEntry
  | { path: string; type: "directory" }
  | { path: string; type: "unsupported" }
  | undefined;

export type WorkerWorkspaceApplyResult = {
  manifestRef: string;
  manifest: WorkerWorkspaceManifest;
  conflictPaths: string[];
  verifyLocalStable(): Promise<void>;
};

export async function assertWorkspaceMatchesManifest(params: {
  root: string;
  manifest: WorkerWorkspaceManifest;
  entries?: readonly WorkerWorkspaceManifestEntry[];
}): Promise<void> {
  const root = await fs.realpath(params.root);
  const expectedNodes = params.entries
    ? reconciliationEntries(params.entries)
    : [...manifestNodes(params.manifest).values()].filter(
        (entry): entry is Exclude<WorkspaceNode, undefined> => entry !== undefined,
      );
  for (const entry of expectedNodes) {
    const matches =
      entry.type === "file" || entry.type === "symlink"
        ? await entryMatches(root, entry)
        : sameEntry(await localWorkspaceNode(root, entry.path), entry);
    if (!matches) {
      throw new ConcurrentWorkspacePathError(
        `Gateway workspace changed after cloud dispatch: ${entry.path}`,
      );
    }
  }
}

function sameEntry(left: WorkspaceNode, right: WorkspaceNode): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function manifestNodes(manifest: WorkerWorkspaceManifest): Map<string, WorkspaceNode> {
  return new Map<string, WorkspaceNode>([
    ...reconciliationDirectories(manifest.directories).map(
      (entryPath) =>
        [
          entryPath,
          {
            path: entryPath,
            type: "directory",
          } as const,
        ] as const,
    ),
    ...reconciliationEntries(manifest.entries).map((entry) => [entry.path, entry] as const),
  ]);
}

function hasPathAncestor(paths: ReadonlySet<string>, entryPath: string): boolean {
  const segments = entryPath.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    if (paths.has(segments.slice(0, index).join("/"))) {
      return true;
    }
  }
  return false;
}

function isPortableWorkspaceSymlink(root: string, entryPath: string, target: string): boolean {
  if (
    !target ||
    target.includes("\\") ||
    path.posix.isAbsolute(target) ||
    path.win32.parse(target).root !== ""
  ) {
    return false;
  }
  const resolved = path.resolve(path.dirname(localPath(root, entryPath)), target);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

export async function localWorkspaceNode(root: string, entryPath: string): Promise<WorkspaceNode> {
  const absolute = localPath(root, entryPath);
  const stats = await fs.lstat(absolute).catch((error: unknown) => {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return undefined;
    }
    throw error;
  });
  if (!stats) {
    return undefined;
  }
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    return { path: entryPath, type: "directory" };
  }
  if (stats.isSymbolicLink()) {
    return { path: entryPath, type: "symlink", mode: 0o777, target: await fs.readlink(absolute) };
  }
  if (!stats.isFile()) {
    return { path: entryPath, type: "unsupported" };
  }
  const snapshot = await readWorkspaceFileSnapshot(root, entryPath);
  if (snapshot.type === "unsupported") {
    return { path: entryPath, type: "unsupported" };
  }
  return {
    path: entryPath,
    type: "file",
    mode: snapshot.mode,
    size: snapshot.size,
    sha256: snapshot.sha256,
  };
}

async function localWorkspaceDescendantPaths(
  root: string,
  entryPaths: readonly string[],
): Promise<string[]> {
  const paths: string[] = [];
  const pending = [...entryPaths];
  let pathBytes = 0;
  let enumeratedEntries = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const names: string[] = [];
    for await (const entry of await fs.opendir(localPath(root, directory))) {
      names.push(entry.name);
      enumeratedEntries += 1;
      if (enumeratedEntries > MAX_RECONCILIATION_ENTRIES) {
        throw new Error("Gateway workspace manifest has too many entries");
      }
    }
    for (const name of names.toSorted()) {
      const childPath = `${directory}/${name}`;
      pathBytes += Buffer.byteLength(childPath);
      if (pathBytes > MAX_RECONCILIATION_PATH_BYTES) {
        throw new Error("Gateway workspace manifest paths exceed their byte limit");
      }
      if (isDerivedWorkspacePath(childPath)) {
        continue;
      }
      paths.push(childPath);
      const stats = await fs.lstat(localPath(root, childPath));
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        pending.push(childPath);
      }
    }
  }
  return paths;
}

export async function readActualWorkspaceManifest(params: {
  root: string;
  baseCommit: string | null;
  preserveDirectories?: ReadonlySet<string>;
  includePaths?: ReadonlySet<string>;
}): Promise<{ manifest: WorkerWorkspaceManifest; manifestRef: string }> {
  const rawEntries: Array<
    WorkerWorkspaceManifestEntry | { path: string; type: "directory"; mode: number }
  > = [];
  let totalBytes = 0;
  let traversedEntries = 0;
  let traversedPathBytes = 0;
  const addEntry = (entry: (typeof rawEntries)[number], bytes = 0): void => {
    totalBytes += bytes;
    if (totalBytes > MAX_RECONCILIATION_TOTAL_BYTES) {
      throw new Error("Gateway workspace manifest exceeds its byte limit");
    }
    rawEntries.push(entry);
    if (rawEntries.length > MAX_RECONCILIATION_ENTRIES) {
      throw new Error("Gateway workspace manifest has too many entries");
    }
  };
  const walk = async (
    relativeDirectory: string,
  ): Promise<{ hasDerivedEntry: boolean; included: boolean }> => {
    const absoluteDirectory = relativeDirectory
      ? localPath(params.root, relativeDirectory)
      : params.root;
    let hasDerivedEntry = false;
    let hasNonDerivedEntry = false;
    for await (const directoryEntry of await fs.opendir(absoluteDirectory)) {
      const name = directoryEntry.name;
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      traversedEntries += 1;
      traversedPathBytes += Buffer.byteLength(relative);
      if (traversedEntries > MAX_RECONCILIATION_ENTRIES) {
        throw new Error("Gateway workspace manifest has too many entries");
      }
      if (traversedPathBytes > MAX_RECONCILIATION_PATH_BYTES) {
        throw new Error("Gateway workspace manifest paths exceed their byte limit");
      }
      if (!relativeDirectory && name === ".git") {
        continue;
      }
      if (isDerivedWorkspacePath(relative)) {
        hasDerivedEntry = true;
        continue;
      }
      if (params.includePaths && !params.includePaths.has(relative)) {
        continue;
      }
      const absolute = localPath(params.root, relative);
      const stats = await fs.lstat(absolute);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        const child = await walk(relative);
        if (child.included || params.preserveDirectories?.has(relative)) {
          addEntry({ path: relative, type: "directory", mode: stats.mode & 0o777 });
          hasNonDerivedEntry = true;
        } else {
          hasDerivedEntry ||= child.hasDerivedEntry;
        }
      } else if (stats.isSymbolicLink()) {
        hasNonDerivedEntry = true;
        const target = await fs.readlink(absolute);
        if (!isPortableWorkspaceSymlink(params.root, relative, target)) {
          // Like other unsupported local nodes, an escaping symlink is retained
          // as a conflict but omitted from the canonical cloud manifest.
          continue;
        }
        addEntry(
          {
            path: relative,
            type: "symlink",
            mode: 0o777,
            target,
          },
          Buffer.byteLength(target),
        );
      } else if (stats.isFile()) {
        hasNonDerivedEntry = true;
        const snapshot = await readWorkspaceFileSnapshot(params.root, relative);
        if (snapshot.type === "unsupported") {
          // Oversized local state is kept in place just like a special node. It
          // is omitted from the portable manifest and conflicts if cloud changed it.
          continue;
        }
        addEntry(
          {
            path: relative,
            type: "file",
            mode: snapshot.mode,
            size: snapshot.size,
            sha256: snapshot.sha256,
          },
          snapshot.size,
        );
      } else {
        hasNonDerivedEntry = true;
        // Special local nodes cannot be represented in a cloud manifest. They
        // remain in place and are surfaced as conflicts when the worker changed
        // the same path; omitting them lets that conflicted turn still finish.
        continue;
      }
    }
    return {
      hasDerivedEntry,
      // Preserve real empty directories, but omit a directory whose only
      // physical contents are excluded derived paths.
      included: hasNonDerivedEntry || !hasDerivedEntry,
    };
  };
  await walk("");
  const directories = rawEntries
    .filter((entry) => entry.type === "directory")
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const manifest: WorkerWorkspaceManifest = {
    version: 1,
    baseCommit: params.baseCommit,
    entries: rawEntries
      .filter((entry): entry is WorkerWorkspaceManifestEntry => entry.type !== "directory")
      .toSorted((left, right) => left.path.localeCompare(right.path)),
    directories: directories.map((entry) => entry.path),
  };
  const raw = serializeWorkerWorkspaceManifest(manifest);
  const manifestRef = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  return {
    manifestRef,
    manifest,
  };
}

export async function inspectAcceptedWorkerWorkspace(params: {
  root: string;
  expectedManifestRef: string;
  allowAdvancedLocalState?: boolean;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
}): Promise<WorkerWorkspaceApplyResult | undefined> {
  const root = await fs.realpath(params.root);
  const preserveDirectories = new Set(reconciliationDirectories(params.current.directories));
  const actual = await readActualWorkspaceManifest({
    root,
    baseCommit: params.current.baseCommit,
    preserveDirectories,
  });
  if (actual.manifestRef !== params.expectedManifestRef && !params.allowAdvancedLocalState) {
    return undefined;
  }
  const preflight = await preflightWorkspaceApply({
    root,
    base: params.base,
    current: params.current,
  });
  const conflictPaths = params.allowAdvancedLocalState
    ? retainedConflictPaths(preflight)
    : preflight.conflictPaths;
  return {
    ...actual,
    conflictPaths,
    verifyLocalStable: async () =>
      await assertActualWorkspaceManifest({
        root,
        expectedRef: actual.manifestRef,
        baseCommit: actual.manifest.baseCommit,
        preserveDirectories,
      }),
  };
}

export async function assertActualWorkspaceManifest(params: {
  root: string;
  expectedRef: string;
  baseCommit: string | null;
  preserveDirectories?: ReadonlySet<string>;
  includePaths?: ReadonlySet<string>;
}): Promise<void> {
  const actual = await readActualWorkspaceManifest(params);
  if (actual.manifestRef !== params.expectedRef) {
    throw new ConcurrentWorkspacePathError("Gateway workspace changed after cloud reconciliation");
  }
}

export function changedPaths(
  base: WorkerWorkspaceManifest,
  current: WorkerWorkspaceManifest,
): Set<string> {
  const baseByPath = manifestNodes(base);
  const currentByPath = manifestNodes(current);
  return new Set(
    [...new Set([...baseByPath.keys(), ...currentByPath.keys()])].filter(
      (entryPath) => !sameEntry(baseByPath.get(entryPath), currentByPath.get(entryPath)),
    ),
  );
}

export function changedEntryPaths(
  base: WorkerWorkspaceManifest,
  current: WorkerWorkspaceManifest,
): Set<string> {
  const baseByPath = new Map(
    reconciliationEntries(base.entries).map((entry) => [entry.path, entry]),
  );
  const currentByPath = new Map(
    reconciliationEntries(current.entries).map((entry) => [entry.path, entry]),
  );
  return new Set(
    [...new Set([...baseByPath.keys(), ...currentByPath.keys()])].filter(
      (entryPath) => !sameEntry(baseByPath.get(entryPath), currentByPath.get(entryPath)),
    ),
  );
}

export async function applyWorkspaceDirectoryChanges(params: {
  root: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
  applyPaths: ReadonlySet<string>;
}): Promise<void> {
  const workspaceRoot = await openFsSafeRoot(params.root, { mode: 0o700 });
  const baseNodes = manifestNodes(params.base);
  const currentNodes = manifestNodes(params.current);
  const directoryPaths = [...params.applyPaths].filter(
    (entryPath) =>
      baseNodes.get(entryPath)?.type === "directory" ||
      currentNodes.get(entryPath)?.type === "directory",
  );
  for (const entryPath of directoryPaths.toSorted()) {
    const currentDirectory = currentNodes.get(entryPath);
    if (currentDirectory?.type === "directory") {
      await workspaceRoot.mkdir(entryPath);
    }
  }
  const removedDirectoryPaths = directoryPaths.filter(
    (entryPath) => baseNodes.get(entryPath)?.type === "directory" && !currentNodes.has(entryPath),
  );
  for (const entryPath of removedDirectoryPaths.toSorted((left, right) =>
    right.localeCompare(left),
  )) {
    const baseDirectory = baseNodes.get(entryPath);
    let directoryState;
    try {
      directoryState = await workspaceRoot.stat(entryPath);
    } catch (error) {
      if (error instanceof FsSafeError && ["not-found", "path-alias"].includes(error.code)) {
        continue;
      }
      throw error;
    }
    if (!directoryState.isDirectory || baseDirectory?.type !== "directory") {
      // A concurrent local replacement or chmod wins and becomes a conflict.
      continue;
    }
    let children: string[];
    try {
      children = await workspaceRoot.list(entryPath);
    } catch (error) {
      if (error instanceof FsSafeError && ["not-found", "path-alias"].includes(error.code)) {
        continue;
      }
      throw error;
    }
    if (children.length > 0) {
      // Conflicted descendants deliberately keep their containing directory
      // even when the cloud result removed that directory.
      continue;
    }
    try {
      await workspaceRoot.remove(entryPath);
    } catch (error) {
      if (error instanceof FsSafeError && ["not-found", "path-alias"].includes(error.code)) {
        continue;
      }
      const racedChildren = await workspaceRoot.list(entryPath).catch(() => undefined);
      if (racedChildren?.length) {
        continue;
      }
      throw error;
    }
  }
}

export function hasReplacedBaseEntryAncestor(
  entryPath: string,
  baseByPath: ReadonlyMap<string, WorkerWorkspaceManifestEntry>,
  currentByPath: ReadonlyMap<string, WorkerWorkspaceManifestEntry>,
): boolean {
  const segments = entryPath.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = segments.slice(0, index).join("/");
    const baseEntry = baseByPath.get(ancestor);
    if (baseEntry && !sameEntry(baseEntry, currentByPath.get(ancestor))) {
      return true;
    }
  }
  return false;
}

export async function preflightWorkspaceApply(params: {
  root: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
}): Promise<{
  applyPaths: Set<string>;
  conflictPaths: string[];
  blockingConflictPaths: string[];
}> {
  const baseNodes = manifestNodes(params.base);
  const currentNodes = manifestNodes(params.current);
  const manifestPaths = [...new Set([...baseNodes.keys(), ...currentNodes.keys()])];
  const changed = new Set(
    manifestPaths.filter(
      (entryPath) => !sameEntry(baseNodes.get(entryPath), currentNodes.get(entryPath)),
    ),
  );
  const structurallyReplacedDirectories = new Set(
    [...changed].filter(
      (entryPath) =>
        baseNodes.get(entryPath)?.type === "directory" &&
        currentNodes.get(entryPath)?.type !== "directory",
    ),
  );
  const structuralRoots = [...structurallyReplacedDirectories].filter(
    (entryPath) => !hasPathAncestor(structurallyReplacedDirectories, entryPath),
  );
  const localStructuralRoots: string[] = [];
  for (const entryPath of structuralRoots) {
    const stats = await fs.lstat(localPath(params.root, entryPath)).catch(() => undefined);
    if (stats?.isDirectory() && !stats.isSymbolicLink()) {
      localStructuralRoots.push(entryPath);
    }
  }
  // Traverse disjoint replacement roots once with one shared budget. A manifest
  // lists every nested directory, so walking from each changed path is quadratic.
  const localStructuralPaths = await localWorkspaceDescendantPaths(
    params.root,
    localStructuralRoots,
  );
  const paths = [...new Set([...changed, ...localStructuralPaths])].toSorted();
  const applyPaths = new Set<string>();
  const conflicts = new Set<string>();
  const blockingConflicts = new Set<string>();
  for (const entryPath of paths) {
    if (hasPathAncestor(blockingConflicts, entryPath)) {
      continue;
    }
    const currentNode = currentNodes.get(entryPath);
    const deletionAlreadySatisfied =
      currentNode === undefined &&
      !(await fs.lstat(localPath(params.root, entryPath)).catch((error: unknown) => {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          return undefined;
        }
        throw error;
      }));
    if (deletionAlreadySatisfied) {
      // A deletion can already be satisfied because local also removed an
      // unchanged ancestor. Do not turn that convergence into a conflict.
      continue;
    }
    const segments = entryPath.split("/");
    let localAncestorConflict = false;
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      const baseAncestor = baseNodes.get(ancestor);
      const currentAncestor = currentNodes.get(ancestor);
      if (!baseAncestor && !currentAncestor) {
        const localAncestor = await localWorkspaceNode(params.root, ancestor);
        if (localAncestor && localAncestor.type !== "directory") {
          conflicts.add(ancestor);
          blockingConflicts.add(ancestor);
          localAncestorConflict = true;
          break;
        }
        continue;
      }
      const localAncestor = await localWorkspaceNode(params.root, ancestor);
      const localStructurallyMatchesBase =
        localAncestor?.type === "directory" && baseAncestor?.type === "directory"
          ? true
          : sameEntry(localAncestor, baseAncestor);
      const localStructurallyMatchesCurrent =
        localAncestor?.type === "directory" && currentAncestor?.type === "directory"
          ? true
          : sameEntry(localAncestor, currentAncestor);
      if (!localStructurallyMatchesBase && !localStructurallyMatchesCurrent) {
        conflicts.add(ancestor);
        blockingConflicts.add(ancestor);
        localAncestorConflict = true;
        break;
      }
    }
    if (localAncestorConflict) {
      continue;
    }
    let local: WorkspaceNode;
    let replacedBaseAncestor = false;
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      const baseAncestor = baseNodes.get(ancestor);
      if (
        baseAncestor &&
        baseAncestor.type !== "directory" &&
        !sameEntry(baseAncestor, currentNodes.get(ancestor)) &&
        sameEntry(await localWorkspaceNode(params.root, ancestor), baseAncestor)
      ) {
        replacedBaseAncestor = true;
        break;
      }
    }
    if (replacedBaseAncestor) {
      local = undefined;
    } else {
      local = await localWorkspaceNode(params.root, entryPath);
      if (
        local?.type === "directory" &&
        (!baseNodes.has(entryPath) || !currentNodes.has(entryPath)) &&
        currentNodes.get(entryPath)?.type !== "directory" &&
        (await directoryContainsOnlyDerivedWorkspaceEntries(params.root, entryPath))
      ) {
        local = undefined;
      }
    }
    if (sameEntry(local, baseNodes.get(entryPath))) {
      if (changed.has(entryPath)) {
        applyPaths.add(entryPath);
      }
    } else if (!sameEntry(local, currentNodes.get(entryPath))) {
      conflicts.add(entryPath);
      const current = currentNodes.get(entryPath);
      if (
        (current?.type === "directory" && local !== undefined && local.type !== "directory") ||
        (current !== undefined && current.type !== "directory" && local?.type === "directory")
      ) {
        blockingConflicts.add(entryPath);
      }
    }
  }
  // Replacing a directory with a file/symlink would erase every descendant in
  // one filesystem operation. Lift a descendant conflict to that replacement.
  const initialConflictPaths = Array.from(conflicts);
  for (const conflictPath of initialConflictPaths) {
    const segments = conflictPath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      const workerNode = currentNodes.get(ancestor);
      if (changed.has(ancestor) && workerNode && workerNode.type !== "directory") {
        conflicts.add(ancestor);
        blockingConflicts.add(ancestor);
        break;
      }
    }
  }
  const conflictPaths = [...conflicts]
    .filter((entryPath) => !hasPathAncestor(blockingConflicts, entryPath))
    .toSorted();
  const blockingConflictPaths = [...blockingConflicts]
    .filter((entryPath) => !hasPathAncestor(blockingConflicts, entryPath))
    .toSorted();
  const conflictPathSet = new Set(conflictPaths);
  const blockingConflictPathSet = new Set(blockingConflictPaths);
  for (const entryPath of applyPaths) {
    if (conflictPathSet.has(entryPath) || hasPathAncestor(blockingConflictPathSet, entryPath)) {
      applyPaths.delete(entryPath);
    }
  }
  return { applyPaths, conflictPaths, blockingConflictPaths };
}

export function retainedConflictPaths(
  preflight: {
    applyPaths: ReadonlySet<string>;
    conflictPaths: readonly string[];
    blockingConflictPaths: readonly string[];
  },
  originalApplyPaths?: ReadonlySet<string>,
): string[] {
  const retainedApplyPaths = [...preflight.applyPaths].filter(
    (entryPath) =>
      !originalApplyPaths?.has(entryPath) ||
      !preflight.conflictPaths.some((conflictPath) => conflictPath.startsWith(`${entryPath}/`)),
  );
  const conflicts = new Set([...preflight.conflictPaths, ...retainedApplyPaths]);
  const blockingConflicts = new Set(preflight.blockingConflictPaths);
  return [...conflicts]
    .filter((entryPath) => !hasPathAncestor(blockingConflicts, entryPath))
    .toSorted();
}

export async function assertWorkspaceResultStable(params: {
  root: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
}): Promise<void> {
  await assertWorkspaceMatchesManifest({ root: params.root, manifest: params.current });
  const preflight = await preflightWorkspaceApply(params);
  const unstablePath = preflight.conflictPaths[0] ?? preflight.applyPaths.values().next().value;
  if (unstablePath) {
    throw new ConcurrentWorkspacePathError(
      `Gateway workspace changed after cloud dispatch: ${unstablePath}`,
    );
  }
}
