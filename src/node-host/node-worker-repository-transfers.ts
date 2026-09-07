import fs from "node:fs/promises";
import path from "node:path";
import { REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS } from "../gateway/github-repository-publication-snapshot.js";
import {
  parseWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceReconciliationJournal,
} from "../gateway/worker-environments/workspace-manifest.js";
import { applyStagedWorkerWorkspace } from "../gateway/worker-environments/workspace-reconcile.js";
import { tempWorkspace } from "../infra/private-temp-workspace.js";
import {
  NODE_WORKSPACE_EMPTY_MANIFEST,
  NODE_WORKSPACE_EMPTY_MANIFEST_REF,
} from "../worker/node-workspace-transfer-protocol.js";
import { runWorkspaceCommand } from "./node-worker-workspace-commands.js";

export async function readNodeRepositoryCheckpointBase(params: {
  manifestHome: string;
  baseManifestRef: string;
  current: WorkerWorkspaceManifest;
}): Promise<WorkerWorkspaceManifest> {
  const raw = await fs.readFile(
    path.join(
      params.manifestHome,
      ".openclaw-worker",
      "manifests",
      `${params.baseManifestRef.slice("sha256:".length)}.json`,
    ),
    "utf8",
  );
  const base = parseWorkerWorkspaceManifest(raw, params.baseManifestRef);
  if (!base.baseCommit || base.baseCommit !== params.current.baseCommit) {
    throw new Error("Repository checkpoint does not match the cloned commit");
  }
  return base;
}

export async function applyNodeRepositoryCheckpoint(params: {
  workspaceDir: string;
  stagingRoot: string;
  baseManifestRef: string;
  currentManifestRef: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
  signal?: AbortSignal;
}): Promise<void> {
  params.signal?.throwIfAborted();
  // Startup owns a fresh clone. A failed import is discarded on reprovisioning,
  // so only this operation owns its synchronous apply journal.
  let journal: WorkerWorkspaceReconciliationJournal | undefined;
  const applied = await applyStagedWorkerWorkspace({
    root: params.workspaceDir,
    stagingRoot: params.stagingRoot,
    baseManifestRef: params.baseManifestRef,
    currentManifestRef: params.currentManifestRef,
    base: params.base,
    current: params.current,
    journal: {
      load: () => journal,
      begin: (next) => {
        journal = next;
      },
      commit: () => {
        journal = undefined;
      },
      abort: () => {
        journal = undefined;
      },
    },
  });
  params.signal?.throwIfAborted();
  if (applied.conflictPaths.length || applied.manifestRef !== params.currentManifestRef) {
    throw new Error("Repository checkpoint conflicts with its freshly cloned base");
  }
  await applied.verifyLocalStable();
  params.signal?.throwIfAborted();
}

export async function withNodeRepositoryPublication<T>(
  params: {
    workspaceDir: string;
    manifestHome: string;
    baseCommit: string;
    baseManifestRef: string;
    signal?: AbortSignal;
  },
  upload: (root: string) => Promise<T>,
): Promise<T> {
  if (params.baseManifestRef !== NODE_WORKSPACE_EMPTY_MANIFEST_REF) {
    throw new Error("Publication transfer baseline is invalid");
  }
  const publication = await tempWorkspace({
    rootDir: path.join(params.manifestHome, ".openclaw-worker", "publication"),
    prefix: "worker-publication-",
  });
  try {
    await runWorkspaceCommand({
      workspaceDir: params.workspaceDir,
      homeDir: params.manifestHome,
      argv: [
        "node",
        "-e",
        REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS,
        params.workspaceDir,
        params.baseCommit,
        publication.dir,
      ],
      signal: params.signal,
    });
    const manifests = path.join(params.manifestHome, ".openclaw-worker", "manifests");
    await fs.mkdir(manifests, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(manifests, `${NODE_WORKSPACE_EMPTY_MANIFEST_REF.slice("sha256:".length)}.json`),
      NODE_WORKSPACE_EMPTY_MANIFEST,
      { mode: 0o600 },
    );
    return await upload(publication.dir);
  } finally {
    await publication.cleanup();
  }
}
