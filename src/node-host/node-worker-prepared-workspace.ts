import fsp from "node:fs/promises";
import path from "node:path";
import type { WorkspaceHashMemo } from "../gateway/worker-environments/workspace-hash-memo.js";
import { parseWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import type {
  NodeWorkerPreparedWorkspaceInput,
  NodeWorkerPreparedWorkspaceResult,
} from "../worker/node-workspace-prepared-protocol.js";
import type {
  NodeWorkerPreparedWorkspaceRow,
  NodeWorkerPreparedWorkspaceStore,
} from "./node-worker-prepared-workspace-store.js";
import { serializeNodeWorkerWorkspace } from "./node-worker-transfer-client.js";
import { captureManifest } from "./node-worker-workspace-commands.js";
import {
  assertNodePreparedWorkspacePaths,
  nodeWorkerWorkspaceLaunchGenerationKey,
} from "./node-worker-workspace-identity.js";

export async function prepareNodeWorkerWorkspace(
  root: string,
  store: NodeWorkerPreparedWorkspaceStore,
  input: NodeWorkerPreparedWorkspaceInput,
  hashMemos: Map<string, WorkspaceHashMemo>,
  signal?: AbortSignal,
): Promise<NodeWorkerPreparedWorkspaceResult> {
  // Compatible snapshots keep absolute build paths; exact preparation stays in the binding row.
  const ownerRoot = path.join(root, input.gatewayNamespace, input.cacheKey);
  return await serializeNodeWorkerWorkspace(ownerRoot, async () => {
    signal?.throwIfAborted();
    let row: NodeWorkerPreparedWorkspaceRow;
    if (input.action === "register") {
      const hashMemo: WorkspaceHashMemo = new Map();
      assertNodePreparedWorkspacePaths(root, input);
      const manifestPath = path.join(
        input.homeDir,
        ".openclaw-worker",
        "manifests",
        `${input.sourceManifestRef.slice(7)}.json`,
      );
      const source = parseWorkerWorkspaceManifest(
        await fsp.readFile(manifestPath, "utf8"),
        input.sourceManifestRef,
      );
      if (
        !source.baseCommit ||
        (
          await captureManifest({
            workspaceDir: input.workspaceDir,
            manifestHome: input.homeDir,
            baseCommit: source.baseCommit,
            referenceManifestRef: input.sourceManifestRef,
            hashMemo,
            signal,
          })
        ).manifestRef !== input.sourceManifestRef
      ) {
        throw new Error("INVALID_REQUEST: prepared workspace source does not match its manifest");
      }
      signal?.throwIfAborted();
      assertNodePreparedWorkspacePaths(root, input);
      row = store.register(input);
      // Only successful registration publishes hashes; failed verification keeps
      // its candidate memo private and cannot replace an accepted registration.
      hashMemos.set(ownerRoot, hashMemo);
    } else {
      const existing = store.find(input.environmentId);
      if (!existing) {
        throw new Error("INVALID_REQUEST: prepared workspace registration is missing");
      }
      assertNodePreparedWorkspacePaths(root, {
        gatewayNamespace: existing.gateway_namespace,
        cacheKey: existing.cache_key,
        workspaceDir: existing.workspace_dir,
        homeDir: existing.home_dir,
      });
      row = store.bind(input);
      const hashMemo = hashMemos.get(ownerRoot);
      if (hashMemo) {
        // Move once, under the workspace fence. Bind replay must not overwrite
        // newer capture hashes already owned by this exact session generation.
        hashMemos.set(nodeWorkerWorkspaceLaunchGenerationKey(input), hashMemo);
        hashMemos.delete(ownerRoot);
      }
    }
    return {
      preparationKey: row.preparation_key,
      cacheKey: row.cache_key,
      environmentId: row.environment_id,
      gatewayNamespace: row.gateway_namespace,
      workspaceDir: row.workspace_dir,
      homeDir: row.home_dir,
      sourceManifestRef: row.source_manifest_ref,
    };
  });
}
