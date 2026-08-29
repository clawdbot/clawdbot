import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { root as openFsSafeRoot } from "../../infra/fs-safe.js";
import {
  createStagedInputPathMatcher,
  stagedInputDirectoriesFromEntries,
  stagedInputPathDirectory,
} from "../../media/staged-inputs.js";
import { isAcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";
import {
  activeWorkspaceHashContext,
  withWorkspaceHashContext,
  withWorkspaceHashMemo,
} from "./workspace-hash-memo.js";
import {
  MAX_RECONCILIATION_ENTRIES,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
  type WorkerWorkspaceReconciliationJournal,
  type WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-manifest.js";
import {
  applyWorkspaceDirectoryChanges,
  assertActualWorkspaceManifest,
  changedPaths,
  ConcurrentWorkspacePathError,
  hasReplacedBaseEntryAncestor,
  manifestNodes,
  preflightWorkspaceApply,
  readActualWorkspaceManifest,
  retainedConflictPaths,
  type WorkerWorkspaceApplyResult,
} from "./workspace-reconcile-core.js";
import {
  prepareNonDirectoryTargets,
  reconciliationDirectories,
  reconciliationEntries,
} from "./workspace-reconcile-derived-paths.js";
import { entryMatches } from "./workspace-reconcile-fs.js";
import {
  applyWorkspacePatch,
  createWorkspacePatch,
  recoverWorkerWorkspaceReconciliation,
} from "./workspace-reconcile-recovery.js";

export async function applyStagedWorkerWorkspace(params: {
  root: string;
  stagingRoot: string;
  baseManifestRef: string;
  currentManifestRef: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
  journal: WorkerWorkspaceReconciliationJournalAdapter;
  publishAcceptedManifest?: (accepted: {
    manifestRef: string;
    manifest: WorkerWorkspaceManifest;
    conflictPaths: string[];
  }) => Promise<void>;
}): Promise<WorkerWorkspaceApplyResult> {
  return await withWorkspaceHashContext(
    async () => await applyStagedWorkerWorkspaceWithMemo(params),
  );
}

async function applyStagedWorkerWorkspaceWithMemo(
  params: Parameters<typeof applyStagedWorkerWorkspace>[0],
): Promise<WorkerWorkspaceApplyResult> {
  const { memo: hashMemo, metrics } = activeWorkspaceHashContext()!;
  const root = await fs.realpath(params.root);
  const stagedInputDirectories = stagedInputDirectoriesFromEntries(params.current.entries);
  const baseNodes = manifestNodes(params.base);
  const currentNodes = manifestNodes(params.current);
  const changed = changedPaths(params.base, params.current);
  const assertInputOwnership = async () => {
    if (stagedInputDirectories.size === 0) {
      return;
    }
    const workspaceRoot = await openFsSafeRoot(root);
    const isRetainedInput = createStagedInputPathMatcher(workspaceRoot);
    const unownedInputDirectories = new Set<string>();
    for (const directory of stagedInputDirectories) {
      if ((await workspaceRoot.exists(directory)) && !(await isRetainedInput(directory))) {
        unownedInputDirectories.add(directory);
      }
    }
    // Worker ownership cannot enroll local project data. Preserve ordinary entries
    // already shared at dispatch, but reject marker changes and newly selected local
    // paths before accepted publication can return their private conflict bytes.
    for (const entryPath of currentNodes.keys()) {
      const directory = stagedInputPathDirectory(entryPath);
      if (!directory || !unownedInputDirectories.has(directory)) {
        continue;
      }
      const changesMarker = entryPath === `${directory}/.gitignore` && changed.has(entryPath);
      const selectsLocalPath = !baseNodes.has(entryPath) && (await workspaceRoot.exists(entryPath));
      if (changesMarker || selectsLocalPath) {
        throw new ConcurrentWorkspacePathError(
          `Cloud input conflicts with an unowned Gateway directory: ${directory}. Keep the project directory unchanged and reattach the input.`,
        );
      }
    }
  };
  await assertInputOwnership();
  const preserveDirectories = new Set(
    reconciliationDirectories(params.current.directories, stagedInputDirectories),
  );
  // Git workspaces must keep the eligibility boundary established at dispatch.
  // Local-only ignored files are outside both manifests and must never enter the accepted state.
  const includePaths = params.current.baseCommit
    ? new Set([...baseNodes.keys(), ...currentNodes.keys()])
    : undefined;
  const createApplyResult = (
    actual: Awaited<ReturnType<typeof readActualWorkspaceManifest>>,
    conflictPaths: string[],
  ): WorkerWorkspaceApplyResult => ({
    ...actual,
    conflictPaths,
    verifyLocalStable: async () =>
      await withWorkspaceHashMemo(
        hashMemo,
        async () =>
          await assertActualWorkspaceManifest({
            root,
            expectedRef: actual.manifestRef,
            baseCommit: actual.manifest.baseCommit,
            preserveDirectories,
            includePaths,
          }),
        metrics,
      ),
  });
  const preflight = await preflightWorkspaceApply({
    root,
    base: params.base,
    current: params.current,
  });
  if (changed.size === 0) {
    const actual = await readActualWorkspaceManifest({
      root,
      baseCommit: params.current.baseCommit,
      preserveDirectories,
      includePaths,
    });
    await assertActualWorkspaceManifest({
      root,
      expectedRef: actual.manifestRef,
      baseCommit: actual.manifest.baseCommit,
      preserveDirectories,
      includePaths,
    });
    const conflictPaths = retainedConflictPaths(preflight, preflight.applyPaths);
    await params.publishAcceptedManifest?.({ ...actual, conflictPaths });
    params.journal.commit(actual.manifestRef);
    return createApplyResult(actual, conflictPaths);
  }
  const baseByPath = new Map(
    reconciliationEntries(params.base.entries).map((entry) => [entry.path, entry]),
  );
  const currentByPath = new Map(
    reconciliationEntries(params.current.entries).map((entry) => [entry.path, entry]),
  );
  const baseEntries = reconciliationEntries(params.base.entries).filter(
    (entry) => changed.has(entry.path) && preflight.applyPaths.has(entry.path),
  );
  const appliedEntries: WorkerWorkspaceManifestEntry[] = [];
  for (const entry of reconciliationEntries(params.current.entries)) {
    if (!changed.has(entry.path) || !preflight.applyPaths.has(entry.path)) {
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
  const baseDirectories = [...preflight.applyPaths]
    .filter((entryPath) => baseNodes.get(entryPath)?.type === "directory")
    .toSorted();
  const appliedDirectories = [...preflight.applyPaths]
    .filter((entryPath) => currentNodes.get(entryPath)?.type === "directory")
    .toSorted();
  if (
    baseEntries.length +
      appliedEntries.length +
      baseDirectories.length +
      appliedDirectories.length >
    MAX_RECONCILIATION_ENTRIES
  ) {
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
  const confirmedPreflight = await preflightWorkspaceApply({
    root,
    base: params.base,
    current: params.current,
  });
  if (
    JSON.stringify([...confirmedPreflight.applyPaths].toSorted()) !==
      JSON.stringify([...preflight.applyPaths].toSorted()) ||
    JSON.stringify(confirmedPreflight.conflictPaths) !== JSON.stringify(preflight.conflictPaths) ||
    JSON.stringify(confirmedPreflight.blockingConflictPaths) !==
      JSON.stringify(preflight.blockingConflictPaths)
  ) {
    throw new ConcurrentWorkspacePathError(
      "Gateway workspace changed while cloud reconciliation was being prepared",
    );
  }
  // Revalidate before mutation, not after applying our own newly admitted paths.
  await assertInputOwnership();
  const journal: WorkerWorkspaceReconciliationJournal = {
    version: 1,
    temporaryNonce: randomBytes(16).toString("hex"),
    baseManifestRef: params.baseManifestRef,
    currentManifestRef: params.currentManifestRef,
    baseEntries,
    appliedEntries,
    baseDirectories,
    appliedDirectories,
    baseTree: snapshot.baseTree,
    basePackSha256: createHash("sha256").update(snapshot.basePack).digest("hex"),
    basePack: snapshot.basePack,
  };
  params.journal.begin(journal);
  try {
    await prepareNonDirectoryTargets(root, appliedEntries);
    await applyWorkspacePatch({ root, patch: snapshot.patch });
    await applyWorkspaceDirectoryChanges({
      root,
      base: params.base,
      current: params.current,
      applyPaths: preflight.applyPaths,
    });
    const actual = await readActualWorkspaceManifest({
      root,
      baseCommit: params.current.baseCommit,
      preserveDirectories,
      includePaths,
    });
    const finalPreflight = await preflightWorkspaceApply({
      root,
      base: params.base,
      current: params.current,
    });
    await assertActualWorkspaceManifest({
      root,
      expectedRef: actual.manifestRef,
      baseCommit: actual.manifest.baseCommit,
      preserveDirectories,
      includePaths,
    });
    const conflictPaths = retainedConflictPaths(finalPreflight, preflight.applyPaths);
    await params.publishAcceptedManifest?.({ ...actual, conflictPaths });
    params.journal.commit(actual.manifestRef);
    return createApplyResult(actual, conflictPaths);
  } catch (error) {
    // Transport or settlement timeouts are observation evidence, never authority
    // for an inverse operation; recovery owns restoring both sides.
    if (isAcceptedWorkspacePublicationIndeterminateError(error)) {
      throw error;
    }
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
