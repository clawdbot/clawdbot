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
import { NODE_WORKER_WORKSPACE_COMMAND_TIMEOUT_MS } from "../worker/node-workspace-deadlines.js";

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
    timeoutMs: NODE_WORKER_WORKSPACE_COMMAND_TIMEOUT_MS,
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
  baseManifestRef?: string;
  hashMemo?: WorkspaceHashMemo;
  signal?: AbortSignal;
}) {
  const hashMemo = params.hashMemo ?? new Map<string, string>();
  // Verification seeds both accepted and original paths so a recreated file cannot
  // disappear behind a new ignore rule. Fresh staging has no published base yet.
  const priorRefs = [
    params.referenceManifestRef,
    ...(params.baseManifestRef ? [params.baseManifestRef] : []),
  ];
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
        ...new Set(priorRefs.map((ref) => ref.slice("sha256:".length))),
        "memo-v1",
      ],
      input: serializeRemoteWorkspaceHashMemo(hashMemo),
      // The local child can return the memo; the node RPC returns only capture facts.
      maxOutputBytes: MAX_WORKSPACE_HASH_MEMO_BYTES + 128 * 1024,
      signal: params.signal,
    })
  ).trim();
  const envelope = parseRemoteWorkspaceManifestEnvelope(stdout);
  replaceWorkerWorkspaceHashMemoEntries(hashMemo, envelope.memo);
  commandLog.debug("node worker manifest capture completed", {
    workspaceDir: params.workspaceDir,
    ...envelope.metrics,
  });
  return {
    version: envelope.version,
    manifestRef: envelope.manifestRef,
    metrics: envelope.metrics,
  };
}
