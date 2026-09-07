import {
  MAX_WORKSPACE_HASH_MEMO_BYTES,
  parseRemoteWorkspaceManifestEnvelope,
  replaceWorkerWorkspaceHashMemoEntries,
  serializeRemoteWorkspaceHashMemo,
  type WorkspaceHashMemo,
} from "../gateway/worker-environments/workspace-hash-memo.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "../gateway/worker-environments/workspace-sync-scripts.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout } from "../process/exec.js";

export const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const commandLog = createSubsystemLogger("node-host/worker-workspace");

/** Environment for node-owned workspace commands: pinned HOME, no credential prompts. */
export function workspaceCommandEnv(homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    ...(process.platform === "win32" ? { USERPROFILE: homeDir } : {}),
    GCM_INTERACTIVE: "Never",
    GIT_ASKPASS: "",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS: "",
  };
}

/** Runs one workspace-scoped command and returns stdout, failing on nonzero exit. */
export async function runWorkspaceCommand(params: {
  workspaceDir: string;
  homeDir: string;
  argv: string[];
  input?: string | Uint8Array;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}): Promise<string> {
  const maxOutputBytes = params.maxOutputBytes ?? 128 * 1024;
  const result = await runCommandWithTimeout(params.argv, {
    cwd: params.workspaceDir,
    baseEnv: workspaceCommandEnv(params.homeDir),
    ...(params.input === undefined ? {} : { input: params.input }),
    timeoutMs: TRANSFER_TIMEOUT_MS,
    signal: params.signal,
    maxOutputBytes,
    maxCombinedOutputBytes: maxOutputBytes + 128 * 1024,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error(`workspace transfer apply failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

/**
 * Captures the workspace manifest with the shared remote script. With a hash
 * memo the capture round-trips memo-v1 so unchanged files reuse prior hashes.
 */
export async function captureManifest(params: {
  workspaceDir: string;
  manifestHome: string;
  baseCommit: string | null;
  referenceManifestRef: string;
  hashMemo?: WorkspaceHashMemo;
  signal?: AbortSignal;
}): Promise<string> {
  const memoMode = params.hashMemo !== undefined;
  const stdout = (
    await runWorkspaceCommand({
      workspaceDir: params.workspaceDir,
      homeDir: params.manifestHome,
      argv: [
        "node",
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        params.workspaceDir,
        params.baseCommit ?? "",
        params.baseCommit ? "eligible" : "all",
        params.referenceManifestRef.slice("sha256:".length),
        ...(memoMode ? ["memo-v1"] : []),
      ],
      ...(params.hashMemo === undefined
        ? {}
        : {
            input: serializeRemoteWorkspaceHashMemo(params.hashMemo),
            // The memo round-trip returns up to the memo byte cap on stdout.
            maxOutputBytes: MAX_WORKSPACE_HASH_MEMO_BYTES + 128 * 1024,
          }),
      signal: params.signal,
    })
  ).trim();
  if (params.hashMemo === undefined) {
    return stdout;
  }
  const envelope = parseRemoteWorkspaceManifestEnvelope(stdout);
  replaceWorkerWorkspaceHashMemoEntries(params.hashMemo, envelope.memo);
  commandLog.debug("node worker manifest capture completed", {
    workspaceDir: params.workspaceDir,
    ...envelope.metrics,
  });
  return envelope.manifestRef;
}
