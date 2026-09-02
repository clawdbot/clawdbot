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

async function bindWorkerGitHubCheckout(cwd: string, binding: WorkerGitHubLaunchBinding) {
  const git = (args: string[]) =>
    runCommandWithTimeout(["git", "-C", cwd, ...args], {
      baseEnv: process.env,
      timeoutMs: 5_000,
      maxOutputBytes: 2_048,
    });
  const requireGit = async (args: string[]) => {
    const result = await git(args);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
    }
    return result.stdout.trim();
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
}): Promise<PreparedGitHubToolEnvironment | undefined> {
  const { binding, stateDir, runId, cwd } = params;
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
  await bindWorkerGitHubCheckout(cwd, binding);
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
      log.warn(`GitHub exec binding skipped: profile is not owner-only: ${profileDir}`);
      return undefined;
    }
  }
  return {
    managedLocalIdentity: true,
    excludedStoreNames: [],
    credentialScrubEnv: { GH_TOKEN: "", GITHUB_TOKEN: "" },
    localIdentityEnv: managedGitHubIdentityEnvironment({
      profileDir,
      gitAuthor: binding.gitAuthor,
      // Reset inherited helpers so paired-device credentials cannot override the turn identity.
      gitConfig: [
        ["credential.helper", ""],
        ["credential.helper", "!gh auth git-credential"],
      ],
    }),
  };
}
