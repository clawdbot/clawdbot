import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  createNodeWorkerRepositoryPreparation,
  WORKER_REPOSITORY_GIT_ARGS,
  type NodeWorkerRepositoryExec,
  type NodeWorkerRepositoryOutcome,
} from "./node-worker-repository-preparation.js";
import type {
  WorkerLocalWorkspaceSyncRequest,
  WorkerWorkspaceSyncResult,
} from "./tunnel-contract.js";
import {
  resolveWorkerWorkspaceGitAuthor,
  validateWorkspaceSyncRequest,
} from "./workspace-sync-helpers.js";

const GIT_TIMEOUT_MS = 60_000;
const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const workspaceSyncLog = createSubsystemLogger("gateway/worker-workspace");

type GitIdentity = { commit: string; origin: string };
type OriginFallbackReason =
  | Extract<NodeWorkerRepositoryOutcome, { kind: "failed" }>["reason"]
  | "inspection-failed"
  | "not-git-workspace"
  | "not-repository-root"
  | "origin-unavailable"
  | "workspace-dirty"
  | "workspace-transfer-required";

type OriginInspection =
  | { kind: "eligible"; identity: GitIdentity }
  | { kind: "fallback"; reason: OriginFallbackReason };

type OriginSyncOutcome =
  | { kind: "synced"; seeded: boolean; result: WorkerWorkspaceSyncResult }
  | { kind: "fallback"; reason: OriginFallbackReason };

export function recordNodeSyncPath(
  environmentId: string,
  sessionId: string,
  outcome: OriginSyncOutcome,
  originStartedAt: number,
): void {
  workspaceSyncLog.info("worker workspace sync path selected", {
    environmentId,
    sessionId,
    path: outcome.kind === "synced" ? "origin" : "gateway-push",
    reason:
      outcome.kind === "synced"
        ? outcome.seeded
          ? "published-origin-seeded"
          : "published-origin"
        : outcome.reason,
    originAttemptMs: performance.now() - originStartedAt,
  });
}

async function localGit(root: string, args: string[]): Promise<string> {
  // Inspection runs inside the Gateway process against a user checkout, so
  // checkout-configured hook/fsmonitor commands must never execute here.
  const result = await runCommandWithTimeout(
    [
      "git",
      "-c",
      `core.hooksPath=${os.devNull}`,
      "-c",
      "core.fsmonitor=false",
      ...WORKER_REPOSITORY_GIT_ARGS,
      "-C",
      root,
      ...args,
    ],
    {
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: 256 * 1024,
      maxCombinedOutputBytes: 512 * 1024,
      outputCapture: "head",
      baseEnv: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
      },
    },
  );
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error("local Git inspection failed");
  }
  return result.stdout.trim();
}

function credentialFreeHttpOrigin(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === ""
    ? parsed.href
    : undefined;
}

async function requiresWorkspaceTransfer(root: string): Promise<boolean> {
  for (const marker of [".worktreeinclude", ".gitmodules"]) {
    try {
      await fs.lstat(path.join(root, marker));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  try {
    return /\bfilter\s*=\s*lfs\b/u.test(
      await fs.readFile(path.join(root, ".gitattributes"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return false;
  }
}

async function inspectEligibleOrigin(localPath: string): Promise<OriginInspection> {
  try {
    const canonicalPath = await fs.realpath(localPath);
    let root: string;
    try {
      root = await fs.realpath(await localGit(canonicalPath, ["rev-parse", "--show-toplevel"]));
    } catch {
      return { kind: "fallback", reason: "not-git-workspace" };
    }
    if (root !== canonicalPath) {
      return { kind: "fallback", reason: "not-repository-root" };
    }
    if (await requiresWorkspaceTransfer(root)) {
      return { kind: "fallback", reason: "workspace-transfer-required" };
    }
    const [status, commit, rawOrigin] = await Promise.all([
      localGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
      localGit(root, ["rev-parse", "HEAD"]),
      localGit(root, ["remote", "get-url", "origin"]).catch(() => ""),
    ]);
    if (status) {
      return { kind: "fallback", reason: "workspace-dirty" };
    }
    const origin = credentialFreeHttpOrigin(rawOrigin);
    if (!COMMIT_PATTERN.test(commit) || !origin) {
      return { kind: "fallback", reason: "origin-unavailable" };
    }
    return { kind: "eligible", identity: { commit, origin } };
  } catch {
    return { kind: "fallback", reason: "inspection-failed" };
  }
}

/** Optional published-origin fast path; HTTPS transfer remains the canonical fallback. */
export function createNodeWorkerWorkspaceFallback(exec: NodeWorkerRepositoryExec) {
  const repository = createNodeWorkerRepositoryPreparation(exec);
  return {
    captureManifest: repository.captureManifest,
    async trySyncWorkspace(
      request: WorkerLocalWorkspaceSyncRequest,
      expectedManifestRef: string,
    ): Promise<OriginSyncOutcome> {
      validateWorkspaceSyncRequest(request);
      const inspection = await inspectEligibleOrigin(request.localPath);
      if (inspection.kind === "fallback") {
        return inspection;
      }
      const prepared = await repository.prepareRepository(inspection.identity, expectedManifestRef);
      return prepared.kind === "prepared"
        ? {
            kind: "synced",
            seeded: prepared.seeded,
            result: {
              mode: "git",
              remoteWorkspaceDir: prepared.result.remoteWorkspaceDir,
              manifestRef: prepared.result.manifestRef,
            },
          }
        : { kind: "fallback", reason: prepared.reason };
    },
    async finalizeSync(
      request: WorkerLocalWorkspaceSyncRequest,
      result: WorkerWorkspaceSyncResult,
    ): Promise<WorkerWorkspaceSyncResult> {
      if (result.mode === "plain") {
        return result;
      }
      const author = await resolveWorkerWorkspaceGitAuthor(request, async (argv) =>
        runCommandWithTimeout(argv, { timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 1024 }),
      );
      await repository.configureAuthor(result.remoteWorkspaceDir, author);
      return result;
    },
  };
}
