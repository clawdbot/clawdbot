// SSH probe execution for SSH-verified node pairing.
// Kept as a narrow runtime boundary so gateway tests can mock the spawn
// without touching the eligibility/verification policy.
import { spawn } from "node:child_process";

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

  return await new Promise<NodeIdentityProbeResult>((resolve) => {
    let settled = false;
    const settle = (result: NodeIdentityProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // PATH-resolved `ssh` keeps Windows OpenSSH working; the gateway process
    // environment is operator-owned, so PATH lookup is not an injection risk.
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(
      () => {
        try {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 1_500).unref();
        } catch {
          // Best-effort teardown; the probe already reports timeout.
        }
        settle({ status: "timeout" });
      },
      Math.max(250, params.timeoutMs),
    );
    timer.unref?.();

    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: unknown): string =>
      current.length >= MAX_PROBE_OUTPUT_BYTES
        ? current
        : (current + String(chunk)).slice(0, MAX_PROBE_OUTPUT_BYTES);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.once("error", (error) => {
      settle({ status: "spawn-error", message: error.message });
    });
    child.once("close", (code) => {
      if (code === 0) {
        settle({ status: "ok", stdout });
      } else {
        settle({ status: "failed", code, stderr });
      }
    });
  });
}
