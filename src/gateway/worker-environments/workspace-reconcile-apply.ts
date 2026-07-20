import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
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
  const root = await fs.realpath(params.root);
  const preserveDirectories = new Set(reconciliationDirectories(params.current.directories));
  // Git workspaces must keep the eligibility boundary established at dispatch.
  // Local-only ignored files are outside both manifests and must never enter the accepted state.
  const includePaths = params.current.baseCommit
    ? new Set([...manifestNodes(params.base).keys(), ...manifestNodes(params.current).keys()])
    : undefined;
  const preflight = await preflightWorkspaceApply({
    root,
    base: params.base,
    current: params.current,
  });
  const changed = changedPaths(params.base, params.current);
  if (changed.size === 0) {
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
    return {
      ...actual,
      conflictPaths,
      verifyLocalStable: async () =>
        await assertActualWorkspaceManifest({
          root,
          expectedRef: actual.manifestRef,
          baseCommit: actual.manifest.baseCommit,
          preserveDirectories,
          includePaths,
        }),
    };
  }
  const baseByPath = new Map(
    reconciliationEntries(params.base.entries).map((entry) => [entry.path, entry]),
  );
  const currentByPath = new Map(
    reconciliationEntries(params.current.entries).map((entry) => [entry.path, entry]),
  );
  const baseNodes = manifestNodes(params.base);
  const currentNodes = manifestNodes(params.current);
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
    return {
      ...actual,
      conflictPaths,
      verifyLocalStable: async () =>
        await assertActualWorkspaceManifest({
          root,
          expectedRef: actual.manifestRef,
          baseCommit: actual.manifest.baseCommit,
          preserveDirectories,
          includePaths,
        }),
    };
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
