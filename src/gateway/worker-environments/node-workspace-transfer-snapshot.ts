import fsp from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../../process/exec.js";
import { MAX_WORKSPACE_INVENTORY_TOTAL_BYTES } from "./workspace-inventory-limits.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile.js";
import {
  createGitTransferList,
  readWorkspaceTransferPaths,
  runLocalCommandToFile,
} from "./workspace-sync-local.js";

const TRANSFER_TIMEOUT_MS = 10 * 60_000;

export type NodeWorkspaceTransferSnapshot = {
  manifest: WorkerWorkspaceManifest;
  manifestRef: string;
  rawManifest: string;
  root: string;
  packPath?: string;
};

async function successfulGit(root: string, args: string[]): Promise<string> {
  const result = await runCommandWithTimeout(["git", "-C", root, ...args], {
    timeoutMs: TRANSFER_TIMEOUT_MS,
    maxOutputBytes: 256 * 1024,
    maxCombinedOutputBytes: 512 * 1024,
    baseEnv: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error("Worker workspace Git inspection failed");
  }
  return result.stdout.trim();
}

export async function prepareNodeWorkspaceTransferSnapshot(params: {
  localPath: string;
  temporaryRoot: string;
  signal?: AbortSignal;
}): Promise<NodeWorkspaceTransferSnapshot> {
  const root = await fsp.realpath(params.localPath);
  const gitAdmin = await fsp.lstat(path.join(root, ".git")).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  let baseCommit: string | null = null;
  let includePaths: ReadonlySet<string> | undefined;
  if (gitAdmin) {
    const gitRoot = await fsp.realpath(await successfulGit(root, ["rev-parse", "--show-toplevel"]));
    if (gitRoot !== root) {
      throw new Error("Worker git workspace sync requires the managed worktree root");
    }
    baseCommit = await successfulGit(root, ["rev-parse", "--verify", "HEAD"]);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(baseCommit)) {
      throw new Error("Worker workspace Git base is not a commit id");
    }
    const transferList = await createGitTransferList({
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
    await runLocalCommandToFile({
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
    await runLocalCommandToFile({
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
