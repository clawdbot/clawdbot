import fsp from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../../infra/fs-safe.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile.js";
import { probeWorkspaceGitMode } from "./workspace-sync-helpers.js";
import {
  createWorkspaceGitTransferList,
  readWorkspaceTransferPaths,
} from "./workspace-sync-inventory.js";

const TRANSFER_TIMEOUT_MS = 10 * 60_000;

export type NodeWorkspaceTransferSnapshot = {
  manifest: WorkerWorkspaceManifest;
  manifestRef: string;
  rawManifest: string;
  root: string;
  /** Sparse checkpoint payloads contain only these paths from the complete manifest. */
  blobPaths?: ReadonlySet<string>;
};

export async function prepareNodeWorkspaceTransferSnapshot(params: {
  localPath: string;
  temporaryRoot: string;
  signal?: AbortSignal;
}): Promise<NodeWorkspaceTransferSnapshot> {
  const root = await fsp.realpath(params.localPath);
  const git = await probeWorkspaceGitMode({
    localPath: root,
    commandOptions: {
      timeoutMs: TRANSFER_TIMEOUT_MS,
      maxOutputBytes: 256 * 1024,
      maxCombinedOutputBytes: 512 * 1024,
      baseEnv: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
      signal: params.signal,
    },
    runTask: runCommandWithTimeout,
  });
  let baseCommit: string | null = null;
  let includePaths: ReadonlySet<string> | undefined;
  if (git.mode === "git") {
    const gitRoot = await fsp.realpath(git.gitRoot);
    if (gitRoot !== root) {
      throw new Error("Worker git workspace sync requires the managed worktree root");
    }
    baseCommit = git.baseCommit;
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(baseCommit)) {
      throw new Error("Worker workspace Git base is not a commit id");
    }
    const transferList = await createWorkspaceGitTransferList({
      gitRoot: root,
      temporaryDirectory: path.join(params.temporaryRoot, "inventory"),
      signal: params.signal ?? AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
    const transferable = await readWorkspaceTransferPaths(transferList);
    const manifestPaths = new Set(transferable);
    for (const relative of transferable) {
      const segments = relative.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        manifestPaths.add(segments.slice(0, index).join("/"));
      }
    }
    includePaths = manifestPaths;
  }
  const actual = await readActualWorkspaceManifest({ root, baseCommit, includePaths });
  return {
    ...actual,
    rawManifest: serializeWorkerWorkspaceManifest(actual.manifest),
    root,
  };
}

export function nodeWorkspaceTransferEntryPath(root: string, relative: string): string {
  const candidate = path.join(root, ...relative.split("/"));
  if (candidate !== root && !isPathInside(root, candidate)) {
    throw new Error("Workspace transfer entry escaped its staging root");
  }
  return candidate;
}
