import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import type {
  WorkerWorkspaceQuiescence,
  WorkerWorkspaceReconcileRequest,
  WorkerWorkspaceReconcileResult,
  WorkerWorkspaceSyncRequest,
  WorkerWorkspaceSyncResult,
} from "./tunnel-contract.js";

const GIT_TIMEOUT_MS = 60_000;
const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const GIT_NONINTERACTIVE_ARGS = ["-c", "credential.helper=", "-c", "core.askPass="];

type WorkerWorkspaceTransportPendingReason =
  | "plain-workspace"
  | "origin-unavailable"
  | "credentialed-origin"
  | "dirty-or-unpublished"
  | "workspace-transfer-required"
  | "changed-results";

class WorkerWorkspaceTransportPendingError extends Error {
  readonly code = "workspace-transport-pending";

  constructor(
    readonly operation: "sync" | "reconcile",
    readonly reason: WorkerWorkspaceTransportPendingReason,
  ) {
    super(
      `workspace transport pending (${operation}: ${reason}); ` +
        "this launch-only fallback requires a clean published HTTP(S) Git checkout",
    );
    this.name = "WorkerWorkspaceTransportPendingError";
  }
}

type WorkspaceExec = (params: {
  argv: string[];
  input?: string;
  resetWorkspace?: boolean;
  timeoutMs?: number;
  transportRetry: "idempotent" | "never";
}) => Promise<SpawnResult & { workspaceDir: string }>;

type GitIdentity = {
  commit: string;
  origin: string;
  root: string;
  manifestRef: string;
};

function pending(
  operation: "sync" | "reconcile",
  reason: WorkerWorkspaceTransportPendingReason,
): never {
  throw new WorkerWorkspaceTransportPendingError(operation, reason);
}

async function localGit(root: string, args: string[]): Promise<string> {
  const result = await runCommandWithTimeout(
    ["git", ...GIT_NONINTERACTIVE_ARGS, "-C", root, ...args],
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
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return undefined;
  }
  return parsed.href;
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

async function inspectLocalGit(
  localPath: string,
  operation: "sync" | "reconcile",
): Promise<GitIdentity> {
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(localPath);
  } catch {
    return pending(operation, "plain-workspace");
  }
  let root: string;
  try {
    root = await fs.realpath(await localGit(canonicalPath, ["rev-parse", "--show-toplevel"]));
  } catch {
    return pending(operation, "plain-workspace");
  }
  if (root !== canonicalPath) {
    return pending(operation, "plain-workspace");
  }
  if (await requiresWorkspaceTransfer(root)) {
    return pending(operation, "workspace-transfer-required");
  }
  const [status, commit, rawOrigin] = await Promise.all([
    localGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    localGit(root, ["rev-parse", "HEAD"]),
    localGit(root, ["remote", "get-url", "origin"]).catch(() => ""),
  ]);
  if (status || !COMMIT_PATTERN.test(commit)) {
    return pending(operation, "dirty-or-unpublished");
  }
  if (!rawOrigin) {
    return pending(operation, "origin-unavailable");
  }
  const origin = credentialFreeHttpOrigin(rawOrigin);
  if (!origin) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(rawOrigin);
    } catch {
      // SCP-like and filesystem origins are intentionally outside this fallback.
    }
    return pending(
      operation,
      parsed?.username || parsed?.password ? "credentialed-origin" : "origin-unavailable",
    );
  }
  const refs = await localGit(root, ["ls-remote", "--heads", "--tags", "--", origin]).catch(
    () => "",
  );
  const published = refs
    .split("\n")
    .some((line) => line.slice(0, commit.length) === commit && /\srefs\//u.test(line));
  if (!published) {
    return pending(operation, "dirty-or-unpublished");
  }
  const manifestRef = `sha256:${createHash("sha256").update(`${origin}\0${commit}`).digest("hex")}`;
  return { commit, origin, root, manifestRef };
}

function requireSuccessfulNodeGit(result: SpawnResult, operation: "sync" | "reconcile"): void {
  if (result.termination !== "exit" || result.code !== 0) {
    pending(operation, operation === "sync" ? "origin-unavailable" : "changed-results");
  }
}

async function inspectNodeGit(
  exec: WorkspaceExec,
  operation: "sync" | "reconcile",
): Promise<{ commit: string; clean: boolean; workspaceDir: string }> {
  const inspected = await exec({
    argv: ["git", "status", "--porcelain=v1", "--untracked-files=all"],
    transportRetry: "idempotent",
  });
  requireSuccessfulNodeGit(inspected, operation);
  const head = await exec({
    argv: ["git", "rev-parse", "HEAD"],
    transportRetry: "idempotent",
  });
  requireSuccessfulNodeGit(head, operation);
  return {
    commit: head.stdout.trim(),
    clean: inspected.stdout.trim() === "",
    workspaceDir: head.workspaceDir,
  };
}

export function createNodeWorkerWorkspaceFallback(
  exec: WorkspaceExec,
  restore?: { localPath: string; manifestRef: string },
) {
  let accepted: GitIdentity | undefined;

  const resolveAccepted = async (operation: "sync" | "reconcile"): Promise<GitIdentity> => {
    if (accepted) {
      return accepted;
    }
    if (!restore) {
      return pending(operation, "changed-results");
    }
    const identity = await inspectLocalGit(restore.localPath, operation);
    if (identity.manifestRef !== restore.manifestRef) {
      return pending(operation, "changed-results");
    }
    accepted = identity;
    return identity;
  };

  const assertUnchanged = async (operation: "sync" | "reconcile") => {
    const identity = await resolveAccepted(operation);
    const [local, node] = await Promise.all([
      inspectLocalGit(identity.root, operation),
      inspectNodeGit(exec, operation),
    ]);
    if (
      local.manifestRef !== identity.manifestRef ||
      !node.clean ||
      node.commit !== identity.commit
    ) {
      return pending(operation, "changed-results");
    }
    return { identity, node };
  };

  return {
    async syncWorkspace(request: WorkerWorkspaceSyncRequest): Promise<WorkerWorkspaceSyncResult> {
      const identity = await inspectLocalGit(request.localPath, "sync");
      const cloned = await exec({
        argv: [
          "git",
          ...GIT_NONINTERACTIVE_ARGS,
          "-c",
          "init.templateDir=",
          "clone",
          "--no-checkout",
          "--",
          identity.origin,
          ".",
        ],
        resetWorkspace: true,
        timeoutMs: GIT_TIMEOUT_MS,
        transportRetry: "never",
      });
      requireSuccessfulNodeGit(cloned, "sync");
      const checkedOut = await exec({
        argv: [
          "git",
          ...GIT_NONINTERACTIVE_ARGS,
          "checkout",
          "--detach",
          "--force",
          identity.commit,
        ],
        timeoutMs: GIT_TIMEOUT_MS,
        transportRetry: "never",
      });
      requireSuccessfulNodeGit(checkedOut, "sync");
      const node = await inspectNodeGit(exec, "sync");
      if (
        !node.clean ||
        node.commit !== identity.commit ||
        checkedOut.workspaceDir !== node.workspaceDir
      ) {
        return pending("sync", "dirty-or-unpublished");
      }
      accepted = identity;
      return {
        mode: "git",
        remoteWorkspaceDir: node.workspaceDir,
        manifestRef: identity.manifestRef,
      };
    },

    async quiesceWorkspace(remoteWorkspaceDir: string): Promise<WorkerWorkspaceQuiescence> {
      const current = await assertUnchanged("reconcile");
      if (current.node.workspaceDir !== remoteWorkspaceDir) {
        return pending("reconcile", "changed-results");
      }
      return {
        assertActive: async () => {
          await assertUnchanged("reconcile");
        },
        resume: async () => {},
      };
    },

    async reconcileWorkspace(
      request: WorkerWorkspaceReconcileRequest,
    ): Promise<WorkerWorkspaceReconcileResult> {
      const current = await assertUnchanged("reconcile");
      if (
        current.node.workspaceDir !== request.remoteWorkspaceDir ||
        current.identity.manifestRef !== request.baseManifestRef
      ) {
        return pending("reconcile", "changed-results");
      }
      request.journal.commit(request.baseManifestRef);
      return {
        manifestRef: request.baseManifestRef,
        changed: false,
        verifyStable: async () => {
          await assertUnchanged("reconcile");
        },
        verifyLocalStable: async () => {
          const local = await inspectLocalGit(current.identity.root, "reconcile");
          if (local.manifestRef !== current.identity.manifestRef) {
            pending("reconcile", "changed-results");
          }
        },
      };
    },
  };
}
