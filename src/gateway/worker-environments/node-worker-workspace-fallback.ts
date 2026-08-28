import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import type {
  WorkerWorkspaceCommand,
  WorkerWorkspaceSyncRequest,
  WorkerWorkspaceSyncResult,
} from "./tunnel-contract.js";
import { boundedWorkerError } from "./worker-error.js";
import {
  resolveWorkerWorkspaceGitAuthor,
  validateWorkspaceSyncRequest,
  workspaceSyncError,
} from "./workspace-sync-helpers.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

const GIT_TIMEOUT_MS = 60_000;
const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const MANIFEST_REF_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const GIT_NONINTERACTIVE_ARGS = ["-c", "credential.helper=", "-c", "core.askPass="];
const workspaceSyncLog = createSubsystemLogger("gateway/worker-workspace");

type WorkspaceExec = (
  params: WorkerWorkspaceCommand & { resetWorkspace?: boolean },
) => Promise<SpawnResult & { workspaceDir: string }>;

type GitIdentity = { commit: string; origin: string; root: string };
type OriginFallbackReason =
  | "clone-failed"
  | "checkout-failed"
  | "inspection-failed"
  | "manifest-capture-failed"
  | "manifest-mismatch"
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
      ...GIT_NONINTERACTIVE_ARGS,
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
    return { kind: "eligible", identity: { commit, origin, root } };
  } catch {
    return { kind: "fallback", reason: "inspection-failed" };
  }
}

function succeeded(result: SpawnResult): boolean {
  return result.termination === "exit" && result.code === 0;
}

/** Optional published-origin fast path; HTTPS transfer remains the canonical fallback. */
export function createNodeWorkerWorkspaceFallback(exec: WorkspaceExec) {
  let supportsSeeds = true;
  let seedStoreFailureLogged = false;
  const capture = async (dir: string, base: string | null, reference?: string) =>
    await exec({
      argv: [
        "node",
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        dir,
        ...(base ? [base, "eligible"] : ["", "all"]),
        ...(reference ? [reference.slice("sha256:".length)] : []),
      ],
      timeoutMs: GIT_TIMEOUT_MS,
      transportRetry: "idempotent",
    });
  const checkoutAndCapture = async (
    identity: GitIdentity,
    workspaceDir: string,
    expectedManifestRef: string,
    seeded: boolean,
  ): Promise<OriginSyncOutcome> => {
    const checkedOut = await exec({
      argv: ["git", ...GIT_NONINTERACTIVE_ARGS, "checkout", "--detach", "--force", identity.commit],
      timeoutMs: GIT_TIMEOUT_MS,
      transportRetry: "never",
    });
    if (!succeeded(checkedOut) || checkedOut.workspaceDir !== workspaceDir) {
      return { kind: "fallback", reason: "checkout-failed" };
    }
    const captured = await capture(checkedOut.workspaceDir, identity.commit);
    const manifestRef = captured.stdout.trim();
    if (!succeeded(captured) || !MANIFEST_REF_PATTERN.test(manifestRef)) {
      return { kind: "fallback", reason: "manifest-capture-failed" };
    }
    if (manifestRef !== expectedManifestRef) {
      return { kind: "fallback", reason: "manifest-mismatch" };
    }
    return {
      kind: "synced",
      seeded,
      result: { mode: "git", remoteWorkspaceDir: checkedOut.workspaceDir, manifestRef },
    };
  };
  return {
    async captureManifest(dir: string, base: string | null, reference: string) {
      const captured = await capture(dir, base, reference);
      const manifestRef = captured.stdout.trim();
      if (!succeeded(captured) || !MANIFEST_REF_PATTERN.test(manifestRef)) {
        const detail = boundedWorkerError(
          captured.stderr.trim() ||
            (!succeeded(captured)
              ? `${captured.termination} (exit code ${captured.code}, signal ${captured.signal})`
              : "invalid manifest reference"),
        );
        throw new Error(`Node workspace manifest capture failed: ${detail}`);
      }
      return manifestRef;
    },
    async trySyncWorkspace(
      request: WorkerWorkspaceSyncRequest,
      expectedManifestRef: string,
    ): Promise<OriginSyncOutcome> {
      validateWorkspaceSyncRequest(request);
      const inspection = await inspectEligibleOrigin(request.localPath);
      if (inspection.kind === "fallback") {
        return inspection;
      }
      const { identity } = inspection;
      const seedKey = createHash("sha256").update(identity.origin).digest("hex");
      let outcome: OriginSyncOutcome | undefined;
      if (supportsSeeds) {
        try {
          const applied = await exec({
            argv: ["openclaw-internal-workspace-seed"],
            seed: { action: "apply", key: seedKey },
            timeoutMs: GIT_TIMEOUT_MS,
            transportRetry: "never",
          });
          if (succeeded(applied) && applied.stdout.trim() === "applied") {
            const remote = await exec({
              argv: ["git", ...GIT_NONINTERACTIVE_ARGS, "remote", "get-url", "origin"],
              timeoutMs: GIT_TIMEOUT_MS,
              transportRetry: "never",
            });
            if (!succeeded(remote) || remote.stdout.trim() !== identity.origin) {
              throw new Error("Node workspace seed origin mismatch");
            }
            const fetched = await exec({
              argv: [
                "git",
                ...GIT_NONINTERACTIVE_ARGS,
                "fetch",
                "--prune",
                "origin",
                "+refs/heads/*:refs/remotes/origin/*",
              ],
              timeoutMs: GIT_TIMEOUT_MS,
              transportRetry: "never",
            });
            if (!succeeded(fetched)) {
              throw workspaceSyncError(fetched);
            }
            outcome = await checkoutAndCapture(
              identity,
              applied.workspaceDir,
              expectedManifestRef,
              true,
            );
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes("INVALID_REQUEST")) {
            supportsSeeds = false;
          }
        }
      }
      if (outcome?.kind !== "synced") {
        const cloned = await exec({
          argv: [
            "git",
            ...GIT_NONINTERACTIVE_ARGS,
            "-c",
            "init.templateDir=",
            "clone",
            "--filter=blob:none",
            "--no-checkout",
            "--",
            identity.origin,
            ".",
          ],
          resetWorkspace: true,
          timeoutMs: GIT_TIMEOUT_MS,
          transportRetry: "never",
        });
        if (!succeeded(cloned)) {
          return { kind: "fallback", reason: "clone-failed" };
        }
        outcome = await checkoutAndCapture(
          identity,
          cloned.workspaceDir,
          expectedManifestRef,
          false,
        );
      }
      if (outcome.kind === "synced" && supportsSeeds) {
        try {
          const stored = await exec({
            argv: ["openclaw-internal-workspace-seed"],
            seed: { action: "store", key: seedKey, maxAgeMs: 6 * 60 * 60 * 1000 },
            timeoutMs: 180_000,
            transportRetry: "never",
          });
          if (!succeeded(stored)) {
            throw workspaceSyncError(stored);
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes("INVALID_REQUEST")) {
            supportsSeeds = false;
          }
          if (!seedStoreFailureLogged) {
            seedStoreFailureLogged = true;
            workspaceSyncLog.warn("node worker workspace seed store failed", {
              error: boundedWorkerError(error),
            });
          }
        }
      }
      return outcome;
    },
    async finalizeSync(
      request: WorkerWorkspaceSyncRequest,
      result: WorkerWorkspaceSyncResult,
    ): Promise<WorkerWorkspaceSyncResult> {
      if (result.mode === "plain") {
        return result;
      }
      const author = await resolveWorkerWorkspaceGitAuthor(request, async (argv) =>
        runCommandWithTimeout(argv, { timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 1024 }),
      );
      const git = ["git", "-C", result.remoteWorkspaceDir, "config", "--local"];
      for (const [key, value] of Object.entries(author)) {
        if (!value) {
          continue;
        }
        const configured = await exec({
          argv: [...git, `user.${key}`, value],
          transportRetry: "never",
        });
        if (!succeeded(configured)) {
          throw workspaceSyncError(configured);
        }
      }
      return result;
    },
  };
}
