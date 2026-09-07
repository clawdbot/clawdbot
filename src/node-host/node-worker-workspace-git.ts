import fsp from "node:fs/promises";
import path from "node:path";
import { MAX_WORKSPACE_MANIFEST_BYTES } from "../gateway/worker-environments/workspace-inventory-limits.js";
import type { WorkerWorkspaceManifestEntry } from "../gateway/worker-environments/workspace-manifest.js";
import { runExec } from "../process/exec.js";
import {
  runWorkspaceCommand,
  TRANSFER_TIMEOUT_MS,
  workspaceCommandEnv,
} from "./node-worker-workspace-commands.js";

export async function initializeNodeWorkerGitWorkspace(params: {
  workspaceDir: string;
  manifestHome: string;
  packPath?: string;
  baseCommit: string;
  entries: WorkerWorkspaceManifestEntry[];
  signal?: AbortSignal;
}): Promise<void> {
  const objectFormat = params.baseCommit.length === 40 ? "sha1" : "sha256";
  if (params.baseCommit.length !== 40 && params.baseCommit.length !== 64) {
    throw new Error("workspace transfer Git base object id is invalid");
  }
  const git = async (args: string[], options: { input?: string; maxOutputBytes?: number } = {}) =>
    await runWorkspaceCommand({
      workspaceDir: params.workspaceDir,
      homeDir: params.manifestHome,
      argv: ["git", "-C", params.workspaceDir, ...args],
      ...(options.input === undefined ? {} : { input: options.input }),
      signal: params.signal,
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    });
  await git(["init", "--quiet", `--object-format=${objectFormat}`, "."]);
  if (params.packPath) {
    const pack = await fsp.open(params.packPath, "r");
    try {
      await runExec("git", ["-C", params.workspaceDir, "index-pack", "--stdin"], {
        cwd: params.workspaceDir,
        baseEnv: workspaceCommandEnv(params.manifestHome),
        stdinFileDescriptor: pack.fd,
        signal: params.signal,
        timeoutMs: TRANSFER_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        logOutput: false,
      });
    } finally {
      await pack.close();
    }
    await fsp.rm(params.packPath, { force: true });
  }
  await fsp.writeFile(path.join(params.workspaceDir, ".git", "shallow"), `${params.baseCommit}\n`);
  const actual = (await git(["rev-parse", "--verify", `${params.baseCommit}^{commit}`])).trim();
  if (actual !== params.baseCommit) {
    throw new Error("workspace transfer Git base does not match the prepared objects");
  }
  await git(["update-ref", "refs/heads/openclaw-worker", params.baseCommit]);
  await git(["symbolic-ref", "HEAD", "refs/heads/openclaw-worker"]);
  await git(["read-tree", params.baseCommit]);
  const index = await git(["ls-files", "--stage", "-z"], {
    maxOutputBytes: MAX_WORKSPACE_MANIFEST_BYTES,
  });
  const gitlinks: string[] = [];
  const basePaths = new Set<string>();
  for (const record of index.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator < 0) {
      continue;
    }
    const indexedPath = record.slice(separator + 1);
    if (record.startsWith("160000 ")) {
      gitlinks.push(indexedPath);
    } else {
      basePaths.add(indexedPath);
    }
  }
  if (gitlinks.length > 0) {
    await git(["update-index", "--skip-worktree", "-z", "--stdin"], {
      input: `${gitlinks.join("\0")}\0`,
    });
  }
  const checkoutPaths = params.entries
    .map((entry) => entry.path)
    .filter((entryPath) => basePaths.has(entryPath));
  if (checkoutPaths.length > 0) {
    await git(["checkout-index", "-z", "--stdin"], {
      input: `${checkoutPaths.join("\0")}\0`,
    });
  }
}
