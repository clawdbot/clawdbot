import path from "node:path";
import type {
  SessionDiffFile,
  SessionFileBrowserEntry,
  SessionFileEntry,
  SessionsDiffParams,
  SessionsDiffResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { readSessionRepositoryCheckpoint } from "../worker-environments/session-repository-checkpoints.js";
import type { resolveRepositoryWorkspaceAccess } from "./session-repository-workspace-access.js";
import { populateSessionFilePreview } from "./workspace-files.js";
import {
  normalizeRelativePath,
  sortWorkspaceEntries,
  WORKSPACE_PREVIEW_MAX_BYTES,
} from "./workspace-fs.js";

type StoredRepository = Extract<
  ReturnType<typeof resolveRepositoryWorkspaceAccess>,
  { kind: "stored" }
>;

async function readArtifacts(access: StoredRepository) {
  access.assertCurrent();
  if (!access.repository.checkpointRef) {
    return undefined;
  }
  const snapshot = await readSessionRepositoryCheckpoint({
    store: access.store,
    workspaceId: access.repository.workspaceId,
    checkpointRef: access.repository.checkpointRef,
  });
  access.assertCurrent();
  const currentPaths = new Set(snapshot.current.entries.map((entry) => entry.path));
  const basePaths = new Set(snapshot.base.entries.map((entry) => entry.path));
  const changes: SessionDiffFile[] = [
    ...snapshot.changedEntries.map((entry) => ({
      path: entry.path,
      status: basePaths.has(entry.path) ? ("modified" as const) : ("added" as const),
      additions: 0,
      deletions: 0,
    })),
    ...snapshot.base.entries
      .filter((entry) => !currentPaths.has(entry.path))
      .map((entry) => ({
        path: entry.path,
        status: "deleted" as const,
        additions: 0,
        deletions: 0,
      })),
  ].toSorted((left, right) => left.path.localeCompare(right.path));
  return { ...snapshot, changes };
}

function fileEntry(filePath: string, size: number | undefined): SessionFileEntry {
  return {
    path: filePath,
    workspacePath: filePath,
    name: path.posix.basename(filePath),
    kind: "modified",
    missing: size === undefined,
    ...(size === undefined ? {} : { size }),
  };
}

function artifactPath(requested: string): string | undefined {
  const normalized = normalizeRelativePath(requested);
  return path.posix.isAbsolute(requested) ||
    path.win32.isAbsolute(requested) ||
    normalized.split("/").includes("..")
    ? undefined
    : normalized;
}

/** Only cumulative changed artifacts are retained; no repository checkout is materialized. */
export async function listRepositoryArtifacts(
  access: StoredRepository,
  request: { path?: string; search?: string },
) {
  const snapshot = await readArtifacts(access);
  const changed = new Map(
    snapshot?.changedEntries
      .filter((entry) => entry.type === "file")
      .map((entry) => [entry.path, entry]) ?? [],
  );
  const files =
    snapshot?.changes.map((entry) => fileEntry(entry.path, changed.get(entry.path)?.size)) ?? [];
  const folder = artifactPath(request.path ?? "");
  if (folder === undefined) {
    return { gitCheckout: true, files };
  }
  const entries = new Map<string, SessionFileBrowserEntry>();
  const query = request.search?.trim().toLowerCase();
  for (const [filePath, entry] of changed) {
    if (query) {
      if (filePath.toLowerCase().includes(query)) {
        entries.set(filePath, {
          path: filePath,
          name: path.posix.basename(filePath),
          kind: "file",
          size: entry.size,
          sessionKind: "modified",
        });
      }
      continue;
    }
    const prefix = folder ? `${folder}/` : "";
    if (!filePath.startsWith(prefix)) {
      continue;
    }
    const remainder = filePath.slice(prefix.length);
    const name = remainder.split("/")[0]!;
    entries.set(`${prefix}${name}`, {
      path: `${prefix}${name}`,
      name,
      kind: remainder.includes("/") ? "directory" : "file",
      sessionKind: "modified",
      ...(remainder.includes("/") ? {} : { size: entry.size }),
    });
  }
  const limit = query ? 500 : 250;
  const parent = path.posix.dirname(folder);
  return {
    gitCheckout: true,
    files,
    browser: {
      path: query ? "" : folder,
      ...(query
        ? { search: request.search }
        : folder
          ? { parentPath: parent === "." ? "" : parent }
          : {}),
      entries: sortWorkspaceEntries([...entries.values()]).slice(0, limit),
      ...(entries.size > limit ? { truncated: true } : {}),
    },
  };
}

export async function getRepositoryArtifact(
  access: StoredRepository,
  requestedPath: string,
): Promise<{ file?: SessionFileEntry }> {
  const selected = artifactPath(requestedPath);
  const snapshot = await readArtifacts(access);
  const entry = snapshot?.changedEntries.find((candidate) => candidate.path === selected);
  if (!snapshot || entry?.type !== "file") {
    throw new Error(
      "This file is not a retained changed artifact. Start the cloud session to read its repository files.",
    );
  }
  const file = fileEntry(entry.path, entry.size);
  if (entry.size <= WORKSPACE_PREVIEW_MAX_BYTES) {
    const content = await snapshot.readEntry(entry);
    access.assertCurrent();
    await populateSessionFilePreview(file, content);
    // Accepted artifacts are immutable; editing resumes with the live worker checkout.
    delete file.hash;
  }
  access.assertCurrent();
  return { file };
}

export async function loadRepositoryArtifactDiff(
  access: StoredRepository,
  params: SessionsDiffParams,
): Promise<SessionsDiffResult> {
  const snapshot = await readArtifacts(access);
  return {
    sessionKey: params.sessionKey,
    branch: access.repository.branch,
    ...(access.repository.baseCommit ? { baseRef: access.repository.baseCommit } : {}),
    files: !params.scope || params.scope === "all" ? (snapshot?.changes ?? []) : [],
    additions: 0,
    deletions: 0,
    unavailableReason: "workspace_stopped",
  };
}
