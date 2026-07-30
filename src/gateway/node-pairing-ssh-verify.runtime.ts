// SSH probe execution for SSH-verified node pairing.
// Kept as a narrow runtime boundary so gateway tests can mock the probe
// without touching the eligibility/verification policy.
import { runUtf8CommandWithTimeout } from "../process/exec.js";

export type NodeIdentityProbeParams = {
  user: string;
  host: string;
  port?: number;
  identity?: string;
  timeoutMs: number;
};

export type NodeIdentityProbeResult =
  | { status: "ok"; stdout: string }
  | { status: "failed"; code: number | null; stderr: string }
  | { status: "timeout" }
  | { status: "spawn-error"; message: string };

const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;

// `sh -lc` loads the remote login profile so `openclaw` resolves on PATH even
// though sshd runs remote commands through a non-login shell.
const REMOTE_IDENTITY_COMMAND = "sh -lc 'openclaw node identity --json'";

/** Read the node device identity back from the pairing host over SSH. */
export async function runNodeIdentityProbe(
  params: NodeIdentityProbeParams,
): Promise<NodeIdentityProbeResult> {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "NumberOfPasswordPrompts=0",
    "-o",
    "PreferredAuthentications=publickey",
    // Auto-approval is an authorization boundary; only hosts whose key is
    // already trusted may vouch for a pairing request.
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=no",
    // The probe target is chosen from the connecting client's IP, i.e. an
    // untrusted host until the key match succeeds. Never expose the gateway
    // user's agent, X11, or any port forward to it, even if the user's ssh
    // config enables forwarding for a matching host.
    "-a",
    "-x",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ForwardX11Trusted=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-p",
    String(params.port ?? 22),
  ];
  if (params.identity?.trim()) {
    args.push("-i", params.identity.trim(), "-o", "IdentitiesOnly=yes");
  }
  // Security: '--' prevents the user@host target from being read as an option.
  args.push("--", `${params.user}@${params.host}`, REMOTE_IDENTITY_COMMAND);

  try {
    // PATH-resolved `ssh` keeps Windows OpenSSH working; the gateway process
    // environment is operator-owned, so PATH lookup is not an injection risk.
    const result = await runUtf8CommandWithTimeout(["ssh", ...args], {
      maxOutputBytes: MAX_PROBE_OUTPUT_BYTES,
      outputCapture: "head",
      timeoutMs: Math.max(250, params.timeoutMs),
    });
    if (result.termination === "timeout") {
      return { status: "timeout" };
    }
    if (result.code === 0) {
      return { status: "ok", stdout: result.stdout };
    }
    return { status: "failed", code: result.code, stderr: result.stderr };
  } catch (error) {
    return {
      status: "spawn-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
