// OpenClaw probes check local tools and Gateway health with bounded subprocess/network work.
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { runCommandWithTimeout } from "../process/exec.js";

/**
 * Local environment probes used by OpenClaw overview loading.
 *
 * Probes are bounded by output and timeout limits so setup/status commands do
 * not hang or retain unbounded child output.
 */
/** Result from probing a local command binary. */
export type LocalCommandProbe = {
  command: string;
  found: boolean;
  version?: string;
  error?: string;
};

const LOCAL_COMMAND_PROBE_OUTPUT_MAX_CHARS = 16 * 1024;
/** Probe a command by running a small version command with bounded output and timeout. */
export async function probeLocalCommand(
  command: string,
  args: string[] = ["--version"],
  opts: { outputLimit?: number; timeoutMs?: number } = {},
): Promise<LocalCommandProbe> {
  const timeoutMs = resolveTimerTimeoutMs(opts.timeoutMs, 1_500);
  const outputLimit = opts.outputLimit ?? LOCAL_COMMAND_PROBE_OUTPUT_MAX_CHARS;
  try {
    const result = await runCommandWithTimeout([command, ...args], {
      killProcessTree: true,
      maxOutputBytes: outputLimit,
      timeoutMs,
    });
    if (result.termination === "timeout") {
      return {
        command,
        found: true,
        error: `timed out after ${timeoutMs}ms`,
      };
    }
    // Version output can arrive on stdout or stderr depending on the CLI.
    const text = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0]?.trim();
    return {
      command,
      found: result.code === 0 || Boolean(text),
      version: text || undefined,
      error: result.code === 0 ? undefined : `exited ${String(result.code)}`,
    };
  } catch (error) {
    const spawnError = error as NodeJS.ErrnoException;
    return {
      command,
      found: spawnError.code !== "ENOENT",
      error: spawnError.code === "ENOENT" ? "not found" : spawnError.message,
    };
  }
}

/** Probe a Gateway URL by translating it to its HTTP /healthz endpoint. */
export async function probeGatewayUrl(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ reachable: boolean; url: string; error?: string }> {
  const httpUrl = url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  const healthUrl = new URL("/healthz", httpUrl).toString();
  const timeoutMs = resolveTimerTimeoutMs(opts.timeoutMs, 900);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;
  try {
    response = await fetch(healthUrl, {
      method: "GET",
      signal: controller.signal,
    });
    return { reachable: response.ok, url, error: response.ok ? undefined : response.statusText };
  } catch (err) {
    return {
      reachable: false,
      url,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
    await response?.body?.cancel().catch(() => undefined);
  }
}
