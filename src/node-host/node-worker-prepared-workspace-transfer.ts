import fsp from "node:fs/promises";
import path from "node:path";
import {
  withWorkerWorkspaceHashMemo,
  type WorkspaceHashMemo,
} from "../gateway/worker-environments/workspace-hash-memo.js";
import {
  parseWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "../gateway/worker-environments/workspace-manifest.js";
import { applyStagedWorkerWorkspace } from "../gateway/worker-environments/workspace-reconcile-apply.js";
import { changedPaths } from "../gateway/worker-environments/workspace-reconcile-core.js";
import type {
  NodeWorkerPreparedWorkspaceRow,
  NodeWorkerPreparedWorkspaceStore,
} from "./node-worker-prepared-workspace-store.js";
import { captureManifest } from "./node-worker-workspace-commands.js";

export type NodeWorkerPreparedWorkspaceTransfer = {
  row: NodeWorkerPreparedWorkspaceRow;
  store: NodeWorkerPreparedWorkspaceStore;
};

/** Download only the eligible delta; absolute build paths and ignored output stay in place. */
export async function prepareNodeWorkerWorkspaceOverlay(params: {
  prepared: NodeWorkerPreparedWorkspaceTransfer;
  manifest: WorkerWorkspaceManifest;
  manifestRef: string;
  hashMemo?: WorkspaceHashMemo;
  signal?: AbortSignal;
}) {
  const { row, store } = params.prepared;
  const readManifest = async (ref: string) =>
    parseWorkerWorkspaceManifest(
      await fsp.readFile(
        path.join(row.home_dir, ".openclaw-worker", "manifests", `${ref.slice(7)}.json`),
        "utf8",
      ),
      ref,
    );
  const source = await readManifest(row.source_manifest_ref);
  if (!source.baseCommit || params.manifest.baseCommit !== source.baseCommit) {
    throw new Error("Prepared workspace transfer does not match its immutable Git base");
  }
  const capture = async (referenceManifestRef: string, baseManifestRef?: string) =>
    (
      await captureManifest({
        workspaceDir: row.workspace_dir,
        manifestHome: row.home_dir,
        baseCommit: source.baseCommit,
        referenceManifestRef,
        baseManifestRef,
        hashMemo: params.hashMemo,
        signal: params.signal,
      })
    ).manifestRef;
  const baseManifestRef = await capture(row.source_manifest_ref);
  const base = await readManifest(baseManifestRef);
  return {
    changed: changedPaths(base, params.manifest),
    apply: async (stagingRoot: string): Promise<string> => {
      params.signal?.throwIfAborted();
      // The normal workspace fence holds throughout. After a crash this row is
      // cleanup-only: no in-memory permit survives to resurrect a partial tree.
      const mutation = store.beginMutation(row);
      let rolledBack = false;
      try {
        await withWorkerWorkspaceHashMemo(
          params.hashMemo ?? new Map(),
          async () =>
            await applyStagedWorkerWorkspace({
              root: row.workspace_dir,
              stagingRoot,
              baseManifestRef,
              currentManifestRef: params.manifestRef,
              base,
              current: params.manifest,
              journal: {
                load: () => undefined,
                begin: () => {},
                commit: () => {},
                abort: () => {
                  rolledBack = true;
                },
              },
              acceptance: {
                kind: "exact-target",
                verify: async () => {
                  if ((await capture(params.manifestRef, baseManifestRef)) !== params.manifestRef) {
                    throw new Error("Prepared workspace overlay verification failed");
                  }
                },
              },
            }),
        );
        params.signal?.throwIfAborted();
        mutation.complete();
        return params.manifestRef;
      } catch (error) {
        if (
          rolledBack &&
          !params.signal?.aborted &&
          (await capture(baseManifestRef)) === baseManifestRef
        ) {
          mutation.complete();
        }
        throw error;
      } finally {
        mutation.close();
      }
    },
  };
}
