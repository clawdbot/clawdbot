import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandBuffered, runCommandWithTimeout } from "../../process/exec.js";
import {
  MAX_RECONCILIATION_ENTRIES,
  MAX_RECONCILIATION_FILE_BYTES,
  MAX_RECONCILIATION_TOTAL_BYTES,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
  type WorkerWorkspaceReconciliationJournal,
  type WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-manifest.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";
import {
  prepareNonDirectoryTargets,
  reconciliationDirectories,
  reconciliationEntries,
} from "./workspace-reconcile-derived-paths.js";
import {
  absoluteEntryMatches,
  clearTemporaryWorkspace,
  directoryContainsOnlyDerivedWorkspaceEntries,
  directoryContainsOnlyJournalPaths,
  entryMatches,
  localPath,
  readWorkspaceTreeFile,
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

const PATCH_TIMEOUT_MS = 10 * 60_000;

class ConcurrentWorkspacePathError extends Error {}

export async function assertWorkspaceMatchesManifest(params: {
  root: string;
  manifest: WorkerWorkspaceManifest;
  entries?: readonly WorkerWorkspaceManifestEntry[];
}): Promise<void> {
  const root = await fs.realpath(params.root);
  for (const entry of reconciliationEntries(params.entries ?? params.manifest.entries)) {
    if (!(await entryMatches(root, entry))) {
      throw new ConcurrentWorkspacePathError(
        `Gateway workspace changed after cloud dispatch: ${entry.path}`,
      );
    }
  }
}

function sameEntry(
  left: WorkerWorkspaceManifestEntry | undefined,
  right: WorkerWorkspaceManifestEntry | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changedPaths(
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

function hasReplacedBaseEntryAncestor(
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

async function preflightWorkspaceApply(params: {
  root: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
}): Promise<void> {
  await assertWorkspaceMatchesManifest({ root: params.root, manifest: params.base });
  const baseEntries = reconciliationEntries(params.base.entries);
  const currentEntries = reconciliationEntries(params.current.entries);
  const baseByPath = new Map(baseEntries.map((entry) => [entry.path, entry]));
  const currentByPath = new Map(currentEntries.map((entry) => [entry.path, entry]));
  const baseDirectories = new Set(reconciliationDirectories(params.base.directories));
  const directoryContainsOnlyBase = async (entryPath: string): Promise<boolean> => {
    const pending = [entryPath];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const name of await fs.readdir(localPath(params.root, directory))) {
        const childPath = `${directory}/${name}`;
        if (isDerivedWorkspacePath(childPath)) {
          continue;
        }
        const stats = await fs.lstat(localPath(params.root, childPath));
        if (stats.isDirectory() && !stats.isSymbolicLink()) {
          if (!baseDirectories.has(childPath)) {
            if (await directoryContainsOnlyDerivedWorkspaceEntries(params.root, childPath)) {
              continue;
            }
            return false;
          }
          pending.push(childPath);
          continue;
        }
        const baseEntry = baseByPath.get(childPath);
        if (!baseEntry || !(await entryMatches(params.root, baseEntry))) {
          return false;
        }
      }
    }
    return true;
  };
  for (const entry of currentEntries) {
    if (baseByPath.has(entry.path)) {
      continue;
    }
    const segments = entry.path.split("/");
    let replacedBaseAncestor = false;
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      const existingAncestor = await fs
        .lstat(localPath(params.root, ancestor))
        .catch(() => undefined);
      if (
        !existingAncestor ||
        (existingAncestor.isDirectory() && !existingAncestor.isSymbolicLink())
      ) {
        continue;
      }
      const baseAncestor = baseByPath.get(ancestor);
      if (baseAncestor && !sameEntry(baseAncestor, currentByPath.get(ancestor))) {
        replacedBaseAncestor = true;
        break;
      }
      throw new Error(`Cloud workspace result conflicts with a local-only path: ${ancestor}`);
    }
    if (replacedBaseAncestor) {
      continue;
    }
    const existing = await fs.lstat(localPath(params.root, entry.path)).catch(() => undefined);
    if (
      existing?.isDirectory() &&
      !existing.isSymbolicLink() &&
      ((baseDirectories.has(entry.path) && (await directoryContainsOnlyBase(entry.path))) ||
        (await directoryContainsOnlyDerivedWorkspaceEntries(params.root, entry.path)))
    ) {
      continue;
    }
    if (existing && !(await entryMatches(params.root, entry))) {
      throw new Error(`Cloud workspace result conflicts with a local-only path: ${entry.path}`);
    }
  }
}

export async function assertWorkspaceResultStable(params: {
  root: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
}): Promise<void> {
  await assertWorkspaceMatchesManifest({ root: params.root, manifest: params.current });
  const currentPaths = new Set(
    reconciliationEntries(params.current.entries).map((entry) => entry.path),
  );
  const currentDirectories = new Set(reconciliationDirectories(params.current.directories));
  for (const entry of reconciliationEntries(params.base.entries)) {
    if (currentPaths.has(entry.path) || currentDirectories.has(entry.path)) {
      continue;
    }
    const existing = await fs.lstat(localPath(params.root, entry.path)).catch(() => undefined);
    if (existing) {
      throw new ConcurrentWorkspacePathError(
        `Gateway workspace changed after cloud dispatch: ${entry.path}`,
      );
    }
  }
}

async function requireGit(
  cwd: string,
  args: string[],
  input?: Uint8Array,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], {
    timeoutMs: PATCH_TIMEOUT_MS,
    ...(input ? { input } : {}),
    ...(env ? { env } : {}),
    maxOutputBytes: 1024 * 1024,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return result.stdout.trim();
}

async function materializeSnapshotEntry(params: {
  root: string;
  entry: WorkerWorkspaceManifestEntry;
  sourceRoot?: string;
  content?: Uint8Array;
}): Promise<void> {
  const target = localPath(params.root, params.entry.path);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (params.entry.type === "symlink") {
    await fs.symlink(params.entry.target, target);
    return;
  }
  if (params.content) {
    await fs.writeFile(target, params.content, { mode: params.entry.mode, flag: "wx" });
  } else if (params.sourceRoot) {
    await fs.copyFile(localPath(params.sourceRoot, params.entry.path), target);
  } else {
    throw new Error(`Cloud workspace snapshot content is missing: ${params.entry.path}`);
  }
  await fs.chmod(target, params.entry.mode);
  if (!(await absoluteEntryMatches(target, params.entry))) {
    throw new Error(`Cloud workspace staged payload is invalid: ${params.entry.path}`);
  }
}

async function writeRawWorkspaceTree(params: {
  repositoryRoot: string;
  entries: readonly WorkerWorkspaceManifestEntry[];
}): Promise<string> {
  // fast-import writes the authenticated bytes directly. A working-tree/index
  // snapshot would apply user attributes, encodings, and clean filters.
  const blobs: Array<{ entry: WorkerWorkspaceManifestEntry; mark: number; content: Uint8Array }> =
    [];
  let mark = 1;
  for (const entry of reconciliationEntries(params.entries).toSorted((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const content =
      entry.type === "symlink"
        ? Buffer.from(entry.target)
        : await fs.readFile(localPath(params.repositoryRoot, entry.path));
    blobs.push({ entry, mark, content });
    mark += 1;
  }
  const ref = `refs/heads/openclaw-snapshot-${randomBytes(16).toString("hex")}`;
  const chunks: Uint8Array[] = [];
  for (const blob of blobs) {
    chunks.push(Buffer.from(`blob\nmark :${blob.mark}\ndata ${blob.content.byteLength}\n`));
    chunks.push(blob.content, Buffer.from("\n"));
  }
  chunks.push(
    Buffer.from(
      `commit ${ref}\ncommitter OpenClaw <noreply@openclaw.ai> 0 +0000\ndata 0\ndeleteall\n`,
    ),
  );
  for (const blob of blobs) {
    const mode =
      blob.entry.type === "symlink"
        ? "120000"
        : (blob.entry.mode & 0o111) !== 0
          ? "100755"
          : "100644";
    chunks.push(Buffer.from(`M ${mode} :${blob.mark} ${JSON.stringify(blob.entry.path)}\n`));
  }
  chunks.push(Buffer.from("done\n"));
  const imported = await runCommandBuffered(
    ["git", "-C", params.repositoryRoot, "fast-import", "--quiet"],
    {
      input: Buffer.concat(chunks),
      timeoutMs: PATCH_TIMEOUT_MS,
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 1024 * 1024 },
    },
  );
  if (imported.termination !== "exit" || imported.code !== 0) {
    throw new Error(imported.stderr.toString("utf8").trim() || "git fast-import failed");
  }
  return await requireGit(params.repositoryRoot, ["rev-parse", `${ref}^{tree}`]);
}

async function createWorkspacePatch(params: {
  root: string;
  stagingRoot: string;
  baseEntries: WorkerWorkspaceManifestEntry[];
  appliedEntries: WorkerWorkspaceManifestEntry[];
}): Promise<{ patch: Uint8Array; baseTree: string; basePack: Uint8Array }> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-patch-"));
  try {
    // Rollback journals have a fixed SHA-1 object-id contract. Do not inherit
    // user or process defaults that can switch temporary repositories to SHA-256.
    await requireGit(temporary, ["init", "--quiet", "--object-format=sha1"]);
    let bytes = 0;
    for (const entry of params.baseEntries) {
      let content: Uint8Array | undefined;
      if (entry.type === "file") {
        if (entry.size > MAX_RECONCILIATION_FILE_BYTES) {
          throw new Error(`Cloud workspace rollback file is too large: ${entry.path}`);
        }
        content = await fs.readFile(localPath(params.root, entry.path));
        bytes += content.byteLength;
      }
      if (bytes > MAX_RECONCILIATION_TOTAL_BYTES) {
        throw new Error("Cloud workspace rollback exceeds its byte limit");
      }
      await materializeSnapshotEntry({ root: temporary, entry, content });
    }
    const baseTree = await writeRawWorkspaceTree({
      repositoryRoot: temporary,
      entries: params.baseEntries,
    });
    const packed = await runCommandBuffered(
      ["git", "-C", temporary, "pack-objects", "--stdout", "--revs"],
      {
        input: Buffer.from(`${baseTree}\n`),
        timeoutMs: PATCH_TIMEOUT_MS,
        maxOutputBytes: {
          stdout: MAX_RECONCILIATION_TOTAL_BYTES + 1,
          stderr: 1024 * 1024,
        },
      },
    );
    if (packed.termination !== "exit" || packed.code !== 0) {
      throw new Error(packed.stderr.toString("utf8").trim() || "git pack-objects failed");
    }
    if (packed.stdout.byteLength > MAX_RECONCILIATION_TOTAL_BYTES) {
      throw new Error("Cloud workspace recovery snapshot exceeds its byte limit");
    }
    for (const name of await fs.readdir(temporary)) {
      if (name !== ".git") {
        await fs.rm(path.join(temporary, name), { recursive: true, force: true });
      }
    }
    for (const entry of params.appliedEntries) {
      await materializeSnapshotEntry({
        root: temporary,
        entry,
        sourceRoot: params.stagingRoot,
      });
    }
    const appliedTree = await writeRawWorkspaceTree({
      repositoryRoot: temporary,
      entries: params.appliedEntries,
    });
    const diff = await runCommandBuffered(
      [
        "git",
        "-C",
        temporary,
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        baseTree,
        appliedTree,
        "--",
      ],
      {
        timeoutMs: PATCH_TIMEOUT_MS,
        maxOutputBytes: {
          stdout: MAX_RECONCILIATION_TOTAL_BYTES + 1,
          stderr: 1024 * 1024,
        },
      },
    );
    if (diff.termination !== "exit" || diff.code !== 0) {
      throw new Error(diff.stderr.toString("utf8").trim() || "git diff failed");
    }
    if (diff.stdout.byteLength > MAX_RECONCILIATION_TOTAL_BYTES) {
      throw new Error("Cloud workspace patch exceeds its byte limit");
    }
    return { patch: diff.stdout, baseTree, basePack: packed.stdout };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function applyWorkspacePatch(params: {
  root: string;
  patch: Uint8Array;
  reverse?: boolean;
}): Promise<void> {
  if (params.patch.byteLength === 0) {
    return;
  }
  // Run no-index with discovery disabled so workspace .gitattributes and
  // repository filter config cannot reinterpret authenticated patch bytes.
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-no-git-"));
  try {
    await requireGit(
      params.root,
      [
        "apply",
        "--no-index",
        "--binary",
        "--whitespace=nowarn",
        ...(params.reverse ? ["--reverse"] : []),
      ],
      params.patch,
      { GIT_DIR: path.join(temporary, ".git") },
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function validateJournalSnapshot(journal: WorkerWorkspaceReconciliationJournal): void {
  if (
    journal.basePack.byteLength > MAX_RECONCILIATION_TOTAL_BYTES ||
    !/^[a-f0-9]{40}$/u.test(journal.baseTree) ||
    createHash("sha256").update(journal.basePack).digest("hex") !== journal.basePackSha256
  ) {
    throw new Error("Cloud workspace reconciliation recovery snapshot is invalid");
  }
}

async function createWorkspaceRecoveryPatch(params: {
  root: string;
  journal: WorkerWorkspaceReconciliationJournal;
}): Promise<Uint8Array> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-recovery-"));
  try {
    await requireGit(temporary, ["init", "--quiet", "--object-format=sha1"]);
    await requireGit(temporary, ["index-pack", "--stdin"], params.journal.basePack);
    await requireGit(temporary, ["cat-file", "-e", `${params.journal.baseTree}^{tree}`]);
    const baseEntries = reconciliationEntries(params.journal.baseEntries);
    const appliedEntries = reconciliationEntries(params.journal.appliedEntries);
    const baseByPath = new Map(baseEntries.map((entry) => [entry.path, entry]));
    const appliedByPath = new Map(appliedEntries.map((entry) => [entry.path, entry]));
    const paths = new Set([...baseByPath.keys(), ...appliedByPath.keys()]);
    const directories = new Set<string>();
    for (const entryPath of paths) {
      const segments = entryPath.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        directories.add(segments.slice(0, index).join("/"));
      }
    }
    const actualEntries: WorkerWorkspaceManifestEntry[] = [];
    for (const entryPath of [...paths].toSorted()) {
      const absolute = localPath(params.root, entryPath);
      const stats = await fs.lstat(absolute).catch(() => undefined);
      if (!stats) {
        const baseEntry = baseByPath.get(entryPath);
        const appliedEntry = appliedByPath.get(entryPath);
        if (baseEntry && appliedEntry) {
          // A missing replacement path is ambiguous: Git may have removed the
          // old entry mid-apply, or the user may have deleted it afterward.
          throw new ConcurrentWorkspacePathError(
            `Gateway workspace changed while cloud recovery was pending: ${entryPath}`,
          );
        }
        continue;
      }
      const baseEntry = baseByPath.get(entryPath);
      const appliedEntry = appliedByPath.get(entryPath);
      if (baseEntry && (await absoluteEntryMatches(absolute, baseEntry))) {
        actualEntries.push(baseEntry);
        continue;
      }
      if (appliedEntry && (await absoluteEntryMatches(absolute, appliedEntry))) {
        actualEntries.push(appliedEntry);
        continue;
      }
      const isJournalDirectory =
        stats.isDirectory() &&
        !stats.isSymbolicLink() &&
        ((directories.has(entryPath) &&
          (await directoryContainsOnlyJournalPaths(params.root, entryPath, paths, directories))) ||
          (await directoryContainsOnlyDerivedWorkspaceEntries(params.root, entryPath)));
      if (!isJournalDirectory) {
        throw new ConcurrentWorkspacePathError(
          `Gateway workspace changed while cloud recovery was pending: ${entryPath}`,
        );
      }
    }
    for (const entry of actualEntries) {
      await materializeSnapshotEntry({
        root: temporary,
        entry,
        sourceRoot: params.root,
      });
    }
    const actualTree = await writeRawWorkspaceTree({
      repositoryRoot: temporary,
      entries: actualEntries,
    });
    let recoveryBaseTree = params.journal.baseTree;
    if (baseEntries.length !== params.journal.baseEntries.length) {
      await clearTemporaryWorkspace(temporary);
      for (const entry of baseEntries) {
        const content =
          entry.type === "file"
            ? await readWorkspaceTreeFile({
                repositoryRoot: temporary,
                tree: params.journal.baseTree,
                entry,
              })
            : undefined;
        await materializeSnapshotEntry({ root: temporary, entry, content });
      }
      recoveryBaseTree = await writeRawWorkspaceTree({
        repositoryRoot: temporary,
        entries: baseEntries,
      });
      await clearTemporaryWorkspace(temporary);
    }
    const diff = await runCommandBuffered(
      [
        "git",
        "-C",
        temporary,
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        actualTree,
        recoveryBaseTree,
        "--",
      ],
      {
        timeoutMs: PATCH_TIMEOUT_MS,
        maxOutputBytes: {
          stdout: MAX_RECONCILIATION_TOTAL_BYTES + 1,
          stderr: 1024 * 1024,
        },
      },
    );
    if (diff.termination !== "exit" || diff.code !== 0) {
      throw new Error(diff.stderr.toString("utf8").trim() || "git recovery diff failed");
    }
    if (diff.stdout.byteLength > MAX_RECONCILIATION_TOTAL_BYTES) {
      throw new Error("Cloud workspace recovery patch exceeds its byte limit");
    }
    return diff.stdout;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function assertWorkspaceRecoveryBase(params: {
  root: string;
  journal: WorkerWorkspaceReconciliationJournal;
}): Promise<void> {
  await assertWorkspaceMatchesManifest({
    root: params.root,
    manifest: { version: 1, baseCommit: null, entries: params.journal.baseEntries },
  });
  const baseEntries = reconciliationEntries(params.journal.baseEntries);
  const appliedEntries = reconciliationEntries(params.journal.appliedEntries);
  const basePaths = new Set(baseEntries.map((entry) => entry.path));
  const baseDirectories = new Set<string>();
  for (const entryPath of basePaths) {
    const segments = entryPath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      baseDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  for (const entry of appliedEntries) {
    if (basePaths.has(entry.path)) {
      continue;
    }
    const existing = await fs.lstat(localPath(params.root, entry.path)).catch(() => undefined);
    if (
      existing?.isDirectory() &&
      !existing.isSymbolicLink() &&
      baseDirectories.has(entry.path) &&
      (await directoryContainsOnlyJournalPaths(params.root, entry.path, basePaths, baseDirectories))
    ) {
      continue;
    }
    if (existing) {
      throw new ConcurrentWorkspacePathError(
        `Gateway workspace changed while cloud recovery was pending: ${entry.path}`,
      );
    }
  }
}

export async function recoverWorkerWorkspaceReconciliation(params: {
  root: string;
  journal: WorkerWorkspaceReconciliationJournal;
  preservePaths?: ReadonlySet<string>;
}): Promise<void> {
  if (params.preservePaths?.size) {
    throw new Error("Cloud workspace patch recovery cannot preserve partial paths");
  }
  const root = await fs.realpath(params.root);
  validateJournalSnapshot(params.journal);
  try {
    await assertWorkspaceRecoveryBase({ root, journal: params.journal });
    return;
  } catch {
    // The journal may be persisted before, during, or after the multi-file apply.
  }
  const recoveryPatch = await createWorkspaceRecoveryPatch({ root, journal: params.journal });
  await prepareNonDirectoryTargets(root, params.journal.baseEntries);
  await applyWorkspacePatch({ root, patch: recoveryPatch });
  await assertWorkspaceRecoveryBase({ root, journal: params.journal });
}

export async function applyStagedWorkerWorkspace(params: {
  root: string;
  stagingRoot: string;
  baseManifestRef: string;
  currentManifestRef: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
  journal: WorkerWorkspaceReconciliationJournalAdapter;
}): Promise<void> {
  const root = await fs.realpath(params.root);
  await preflightWorkspaceApply({ root, base: params.base, current: params.current });
  const changed = changedPaths(params.base, params.current);
  if (changed.size === 0) {
    params.journal.commit(params.currentManifestRef);
    return;
  }
  const baseByPath = new Map(
    reconciliationEntries(params.base.entries).map((entry) => [entry.path, entry]),
  );
  const currentByPath = new Map(
    reconciliationEntries(params.current.entries).map((entry) => [entry.path, entry]),
  );
  const baseEntries = reconciliationEntries(params.base.entries).filter((entry) =>
    changed.has(entry.path),
  );
  const appliedEntries: WorkerWorkspaceManifestEntry[] = [];
  for (const entry of reconciliationEntries(params.current.entries)) {
    if (!changed.has(entry.path)) {
      continue;
    }
    if (
      !baseByPath.has(entry.path) &&
      !hasReplacedBaseEntryAncestor(entry.path, baseByPath, currentByPath) &&
      (await entryMatches(root, entry))
    ) {
      continue;
    }
    appliedEntries.push(entry);
  }
  if (baseEntries.length + appliedEntries.length > MAX_RECONCILIATION_ENTRIES) {
    throw new Error(
      `Cloud workspace reconciliation exceeds the ${MAX_RECONCILIATION_ENTRIES} entry limit`,
    );
  }
  const snapshot = await createWorkspacePatch({
    root,
    stagingRoot: params.stagingRoot,
    baseEntries,
    appliedEntries,
  });
  const journal: WorkerWorkspaceReconciliationJournal = {
    version: 1,
    temporaryNonce: randomBytes(16).toString("hex"),
    baseManifestRef: params.baseManifestRef,
    currentManifestRef: params.currentManifestRef,
    baseEntries,
    appliedEntries,
    baseTree: snapshot.baseTree,
    basePackSha256: createHash("sha256").update(snapshot.basePack).digest("hex"),
    basePack: snapshot.basePack,
  };
  params.journal.begin(journal);
  try {
    await prepareNonDirectoryTargets(root, appliedEntries);
    await applyWorkspacePatch({ root, patch: snapshot.patch });
    await assertWorkspaceResultStable({ root, base: params.base, current: params.current });
    params.journal.commit(params.currentManifestRef);
  } catch (error) {
    try {
      await recoverWorkerWorkspaceReconciliation({ root, journal });
      params.journal.abort();
    } catch (rollbackError) {
      const recoveryError = new Error("Cloud reconciliation failed and rollback needs recovery", {
        cause: error,
      });
      Object.defineProperty(recoveryError, "rollbackError", { value: rollbackError });
      throw recoveryError;
    }
    throw error;
  }
}
