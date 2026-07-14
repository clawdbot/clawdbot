// Runtime helpers for bounded subprocess log tails and service runtime lookups.
import { runCommandWithTimeout } from "../process/exec.js";

export { buildGatewayConnectionDetails } from "../gateway/call.js";
export { resolveGatewaySystemdServiceName } from "../daemon/constants.js";
export { readSystemdServiceRuntime } from "../daemon/systemd.js";

type ExecFileTailResult = { stdout: string; stderr: string; code: number; truncated: boolean };

const STDERR_MAX_BYTES = 64 * 1024;

export async function execFileUtf8Tail(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBytes: number },
): Promise<ExecFileTailResult> {
  try {
    const result = await runCommandWithTimeout([command, ...args], {
      baseEnv: options.env,
      maxOutputBytes: { stdout: options.maxBytes, stderr: STDERR_MAX_BYTES },
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code ?? 1,
      truncated: Boolean(result.stdoutTruncatedBytes),
    };
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: 1,
      truncated: false,
    };
  }
}
