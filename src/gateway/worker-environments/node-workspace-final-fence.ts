import {
  NODE_WORKER_WORKSPACE_COMMAND_TIMEOUT_MS,
  NODE_WORKER_WORKSPACE_STDERR_MAX_BYTES,
  NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES,
} from "../../worker/node-workspace-protocol.js";
import type { WorkerWorkspaceCommand, WorkerWorkspaceQuiescence } from "./tunnel-contract.js";
import { REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS } from "./workspace-quiescence-scripts.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

// Children stay in the invocation's process group and retain their individual deadlines.
// Send their source on stdin: composing both scripts in argv exceeds Windows' command-line cap.
const NODE_WORKSPACE_FINAL_FENCE_JS = String.raw`const childProcess = require("node:child_process");
function runScript(script, args) {
  const result = childProcess.spawnSync(process.execPath, ["-", ...args], {
    input: "process.argv.splice(1, 1);\n" + script,
    encoding: "utf8",
    timeout: ${NODE_WORKER_WORKSPACE_COMMAND_TIMEOUT_MS},
    killSignal: "SIGKILL",
    maxBuffer: ${NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES},
  });
  if (result.error || result.status !== 0 || result.signal) {
    const detail = result.error?.message || result.stderr?.trim() || "command did not exit successfully";
    throw new Error("Workspace final fence failed: " + detail);
  }
  return result.stdout.trim();
}
function main() {
  const [root, nonce, leaseTimeoutMs, capture] = process.argv.slice(1);
  if (capture !== "before-and-after" && capture !== "after") throw new Error("invalid workspace fence capture order");
  const { manifestScript, renewalScript, manifest } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const verify = () => {
    const observed = runScript(manifestScript, [
      root,
      ...(manifest.baseCommit ? [manifest.baseCommit, "eligible"] : ["", "all"]),
      ...manifest.priorManifestDigests,
    ]);
    if (observed !== manifest.expectedManifestRef) throw new Error("Cloud workspace changed during final reconciliation");
  };
  if (capture === "before-and-after") verify();
  const acknowledgement = "renewed " + nonce;
  if (runScript(renewalScript, [root, nonce, leaseTimeoutMs, "final", "shared-host"]) !== acknowledgement) {
    throw new Error("Worker workspace quiescence renewal returned an invalid acknowledgement");
  }
  verify();
  // The Windows renewal child's exit must not acknowledge before this capture.
  process.stdout.write(acknowledgement + "\n");
}
try { main(); } catch (error) {
  // Leave room for multibyte text and the newline inside the node stderr byte cap.
  process.stderr.write(String(error.message || error).slice(0, ${Math.floor(NODE_WORKER_WORKSPACE_STDERR_MAX_BYTES / 4)}) + "\n");
  process.exitCode = 1;
}
`;

export function buildNodeWorkspaceFinalFenceCommand(params: {
  workspaceDir: string;
  nonce: string;
  leaseTimeoutMs: number;
  fence: NonNullable<Parameters<WorkerWorkspaceQuiescence["assertActive"]>[0]>;
}): Pick<WorkerWorkspaceCommand, "argv" | "input" | "timeoutMs"> {
  const { manifest, capture } = params.fence;
  return {
    argv: [
      "node",
      "-e",
      NODE_WORKSPACE_FINAL_FENCE_JS,
      params.workspaceDir,
      params.nonce,
      String(params.leaseTimeoutMs),
      capture,
    ],
    input: JSON.stringify({
      manifestScript: REMOTE_WORKSPACE_MANIFEST_JS,
      renewalScript: REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
      manifest: {
        baseCommit: manifest.baseCommit,
        expectedManifestRef: manifest.expectedManifestRef,
        priorManifestDigests: manifest.priorManifestDigests,
      },
    }),
    // Preserve the existing steps' aggregate budget, not a longer per-step limit.
    timeoutMs: (capture === "before-and-after" ? 3 : 2) * NODE_WORKER_WORKSPACE_COMMAND_TIMEOUT_MS,
  };
}
