import fsp from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../../process/exec.js";
import { MAX_WORKSPACE_INVENTORY_TOTAL_BYTES } from "./workspace-inventory-limits.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile.js";
import { probeWorkspaceGitMode } from "./workspace-sync-helpers.js";
import {
  createWorkspaceGitTransferList,
  readWorkspaceTransferPaths,
  runWorkspaceInventoryCommandToFile,
} from "./workspace-sync-inventory.js";

const TRANSFER_TIMEOUT_MS = 10 * 60_000;

export type NodeWorkspaceTransferSnapshot = {
  manifest: WorkerWorkspaceManifest;
  manifestRef: string;
  rawManifest: string;
  root: string;
  packPath?: string;
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
  let packPath: string | undefined;
  if (baseCommit) {
    const signal = params.signal ?? AbortSignal.timeout(TRANSFER_TIMEOUT_MS);
    const objectListPath = path.join(params.temporaryRoot, "base-objects");
    packPath = path.join(params.temporaryRoot, "base.pack");
    await runWorkspaceInventoryCommandToFile({
      argv: [
        "git",
        "-C",
        root,
        "rev-list",
        "--objects",
        "--no-object-names",
        `${baseCommit}^{tree}`,
      ],
      outputPath: objectListPath,
      signal,
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
    await fsp.appendFile(objectListPath, `${baseCommit}\n`);
    await runWorkspaceInventoryCommandToFile({
      argv: ["git", "-C", root, "pack-objects", "--stdout"],
      inputPath: objectListPath,
      outputPath: packPath,
      signal,
      timeoutMs: TRANSFER_TIMEOUT_MS,
      maxOutputBytes: MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
    });
  }
  return {
    ...actual,
    rawManifest: serializeWorkerWorkspaceManifest(actual.manifest),
    root,
    ...(packPath ? { packPath } : {}),
  };
}
