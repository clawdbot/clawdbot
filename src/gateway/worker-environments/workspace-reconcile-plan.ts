import type {
  WorkerWorkspaceManifest,
  WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import {
  reconciliationDirectories,
  reconciliationEntries,
} from "./workspace-reconcile-derived-paths.js";

export type WorkspaceNode =
  | WorkerWorkspaceManifestEntry
  | { path: string; type: "directory" }
  | { path: string; type: "unsupported" }
  | undefined;

export function sameWorkspaceNode(left: WorkspaceNode, right: WorkspaceNode): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function manifestNodes(manifest: WorkerWorkspaceManifest): Map<string, WorkspaceNode> {
  return new Map<string, WorkspaceNode>([
    ...reconciliationDirectories(manifest.directories).map(
      (entryPath) => [entryPath, { path: entryPath, type: "directory" } as const] as const,
    ),
    ...reconciliationEntries(manifest.entries).map((entry) => [entry.path, entry] as const),
  ]);
}

export function changedPaths(
  base: WorkerWorkspaceManifest,
  current: WorkerWorkspaceManifest,
): Set<string> {
  const baseByPath = manifestNodes(base);
  const currentByPath = manifestNodes(current);
  return new Set(
    [...new Set([...baseByPath.keys(), ...currentByPath.keys()])].filter(
      (entryPath) => !sameWorkspaceNode(baseByPath.get(entryPath), currentByPath.get(entryPath)),
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
      (entryPath) => !sameWorkspaceNode(baseByPath.get(entryPath), currentByPath.get(entryPath)),
    ),
  );
}

export function workspaceReconciliationRecordCount(
  base: WorkerWorkspaceManifest,
  current: WorkerWorkspaceManifest,
): number {
  const baseNodes = manifestNodes(base);
  const currentNodes = manifestNodes(current);
  let records = 0;
  for (const entryPath of new Set([...baseNodes.keys(), ...currentNodes.keys()])) {
    if (!sameWorkspaceNode(baseNodes.get(entryPath), currentNodes.get(entryPath))) {
      records += Number(baseNodes.has(entryPath)) + Number(currentNodes.has(entryPath));
    }
  }
  return records;
}
