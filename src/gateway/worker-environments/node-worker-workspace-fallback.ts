import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import type { WorkerWorkspaceSyncRequest, WorkerWorkspaceSyncResult } from "./tunnel-contract.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

const GIT_TIMEOUT_MS = 60_000;
const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const MANIFEST_REF_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const GIT_NONINTERACTIVE_ARGS = ["-c", "credential.helper=", "-c", "core.askPass="];

type WorkspaceExec = (params: {
  argv: string[];
  input?: string;
  resetWorkspace?: boolean;
  timeoutMs?: number;
  transportRetry: "idempotent" | "never";
}) => Promise<SpawnResult & { workspaceDir: string }>;

type GitIdentity = { commit: string; origin: string; root: string };

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

async function inspectEligibleOrigin(localPath: string): Promise<GitIdentity | undefined> {
  try {
    const canonicalPath = await fs.realpath(localPath);
    const root = await fs.realpath(await localGit(canonicalPath, ["rev-parse", "--show-toplevel"]));
    if (root !== canonicalPath) {
      return undefined;
    }
    if (await requiresWorkspaceTransfer(root)) {
      return undefined;
    }
    const [status, commit, rawOrigin] = await Promise.all([
      localGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
      localGit(root, ["rev-parse", "HEAD"]),
      localGit(root, ["remote", "get-url", "origin"]).catch(() => ""),
    ]);
    const origin = credentialFreeHttpOrigin(rawOrigin);
    if (status || !COMMIT_PATTERN.test(commit) || !origin) {
      return undefined;
    }
    const refs = await localGit(root, ["ls-remote", "--heads", "--tags", "--", origin]).catch(
      () => "",
    );
    return refs
      .split("\n")
      .some((line) => line.slice(0, commit.length) === commit && /\srefs\//u.test(line))
      ? { commit, origin, root }
      : undefined;
  } catch {
    return undefined;
  }
}

function succeeded(result: SpawnResult): boolean {
  return result.termination === "exit" && result.code === 0;
}

/** Optional published-origin fast path; HTTPS transfer remains the canonical fallback. */
export function createNodeWorkerWorkspaceFallback(exec: WorkspaceExec) {
  return {
    async trySyncWorkspace(
      request: WorkerWorkspaceSyncRequest,
      expectedManifestRef: string,
    ): Promise<WorkerWorkspaceSyncResult | undefined> {
      const identity = await inspectEligibleOrigin(request.localPath);
      if (!identity) {
        return undefined;
      }
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
      if (!succeeded(cloned)) {
        return undefined;
      }
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
      if (!succeeded(checkedOut) || checkedOut.workspaceDir !== cloned.workspaceDir) {
        return undefined;
      }
      const captured = await exec({
        argv: [
          "node",
          "-e",
          REMOTE_WORKSPACE_MANIFEST_JS,
          checkedOut.workspaceDir,
          identity.commit,
          "eligible",
        ],
        timeoutMs: GIT_TIMEOUT_MS,
        transportRetry: "idempotent",
      });
      const manifestRef = captured.stdout.trim();
      if (
        !succeeded(captured) ||
        !MANIFEST_REF_PATTERN.test(manifestRef) ||
        manifestRef !== expectedManifestRef
      ) {
        return undefined;
      }
      return { mode: "git", remoteWorkspaceDir: checkedOut.workspaceDir, manifestRef };
    },
  };
}
