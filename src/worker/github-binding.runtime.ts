import fs from "node:fs/promises";
import path from "node:path";
import {
  managedGitHubIdentityEnvironment,
  writeManagedGitHubProfileFiles,
  type PreparedGitHubToolEnvironment,
} from "../agents/github-tool-identity.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import { inspectPathPermissions } from "../infra/permissions.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { WorkerGitHubLaunchBinding } from "./launch-descriptor.js";

const log = createSubsystemLogger("worker/github");

async function bindWorkerGitHubCheckout(
  cwd: string,
  binding: WorkerGitHubLaunchBinding,
  baseEnv: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) {
  const git = (args: string[], timeoutMs = 5_000) =>
    runCommandWithTimeout(["git", "-C", cwd, ...args], {
      baseEnv,
      timeoutMs,
      maxOutputBytes: { stdout: 1_048_576, stderr: 2_048 },
      ...(signal ? { signal } : {}),
    });
  const requireGit = async (args: string[]) => {
    const result = await git(args);
    if (result.code !== 0 || result.stdoutTruncatedBytes) {
      throw new Error(`git ${args[0]} failed or output was truncated (exit ${result.code})`);
    }
    return result.stdout;
  };
  try {
    if ((await git(["rev-parse", "--git-dir"])).code !== 0) {
      return;
    }
    if (binding.remoteUrl) {
      const origin = await git(["remote", "get-url", "origin"]);
      if (origin.code !== 0) {
        await requireGit(["remote", "add", "origin", binding.remoteUrl]);
      } else if (origin.stdout.trim() !== binding.remoteUrl) {
        await requireGit(["remote", "set-url", "origin", binding.remoteUrl]);
      }
    }
    const head = await git(["symbolic-ref", "--quiet", "HEAD"]);
    const branch = `refs/heads/${binding.branch}`;
    if (head.code !== 0 || head.stdout.trim() !== branch) {
      await requireGit(["update-ref", branch, "HEAD"]);
      await requireGit(["symbolic-ref", "HEAD", branch]);
    }
    // Reconciliation returns files, not commits; origin holds this session's own pushed history.
    // A fast-forward only adds session commits while preserving reconciled working-tree bytes.
    // Leave divergence for the agent to resolve. Only the verified GitHub origin the Gateway
    // named may receive the token-bound fetch; a binding without one keeps its checkout as is.
    // A fenced turn has lost its authority: never start the credentialed fetch for it.
    if (!binding.remoteUrl || signal?.aborted) {
      return;
    }
    const fetched = await git(["fetch", "--quiet", "origin", binding.branch], 60_000);
    if (fetched.code !== 0) {
      if (fetched.stderr.includes("couldn't find remote ref")) {
        return;
      }
      throw new Error(`git fetch failed (exit ${fetched.code})`);
    }
    await requireGit(["update-ref", `refs/remotes/origin/${binding.branch}`, "FETCH_HEAD"]);
    // A tracked upstream lets a bare `git push` and `git status -sb` work on a fresh checkout.
    await requireGit(["branch", `--set-upstream-to=origin/${binding.branch}`, binding.branch]);
    const local = (await requireGit(["rev-parse", "HEAD"])).trim();
    const remote = (await requireGit(["rev-parse", "FETCH_HEAD"])).trim();
    if (local === remote) {
      return;
    }
    if ((await git(["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"])).code !== 0) {
      log.warn(
        `GitHub checkout fast-forward skipped: ${binding.branch} HEAD=${local.slice(0, 7)} origin=${remote.slice(0, 7)}`,
      );
      return;
    }
    if (signal?.aborted) {
      return;
    }
    // Paths already missing before the move are the session's own deletions and stay
    // deleted; only files the incoming commits introduce are materialized.
    const listDeleted = async () =>
      (await requireGit(["ls-files", "--deleted", "-z"])).split("\0").filter(Boolean);
    const deletedBefore = new Set(await listDeleted());
    await requireGit(["reset", "--mixed", "FETCH_HEAD"]);
    const missing = (await listDeleted()).filter((file) => !deletedBefore.has(file));
    if (missing.length > 0) {
      await requireGit(["--literal-pathspecs", "checkout", "--", ...missing]);
    }
  } catch (error) {
    // Checkout metadata helps direct publication; a failure must not discard the coding turn.
    log.warn(`GitHub checkout binding failed: ${String(error).slice(0, 2_048)}`);
  }
}

export async function prepareWorkerGitHubEnvironment(params: {
  binding: WorkerGitHubLaunchBinding;
  stateDir: string;
  runId: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<PreparedGitHubToolEnvironment | undefined> {
  const { binding, stateDir, runId, cwd, signal } = params;
  registerSecretValueForRedaction(binding.token);
  const profilesRoot = path.join(stateDir, "github-profiles");
  const profileDir = path.join(profilesRoot, sha256HexPrefixCore(runId, 16));
  try {
    // Retained workers reuse state across turns, but each turn owns one profile path.
    // Remove earlier profiles first so an inherited path cannot expose a later credential;
    // an earlier process keeps only the token in its own environment.
    await fs.rm(profilesRoot, { recursive: true, force: true });
    await writeManagedGitHubProfileFiles(profileDir, binding);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Worker GitHub identity profile could not be written: ${message}`, {
      cause: error,
    });
  }
  const localIdentityEnv = managedGitHubIdentityEnvironment({
    profileDir,
    gitAuthor: binding.gitAuthor,
    // Reset inherited helpers so paired-device credentials cannot override the turn identity.
    gitConfig: [
      ["credential.helper", ""],
      ["credential.helper", "!gh auth git-credential"],
    ],
  });
  if (process.platform === "win32") {
    const permissions = await inspectPathPermissions(profileDir);
    if (
      !permissions.ok ||
      permissions.source !== "windows-acl" ||
      permissions.ownerTrusted !== true ||
      permissions.groupReadable ||
      permissions.worldReadable ||
      permissions.groupWritable ||
      permissions.worldWritable
    ) {
      log.warn(`GitHub binding skipped: profile is not owner-only: ${profileDir}`);
      return undefined;
    }
  }
  await bindWorkerGitHubCheckout(
    cwd,
    binding,
    {
      ...process.env,
      ...localIdentityEnv,
      GH_TOKEN: binding.token,
      GITHUB_TOKEN: "",
    },
    signal,
  );
  return {
    managedLocalIdentity: true,
    excludedStoreNames: [],
    credentialScrubEnv: { GH_TOKEN: "", GITHUB_TOKEN: "" },
    localIdentityEnv,
  };
}
