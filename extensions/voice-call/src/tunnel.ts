// Voice Call plugin module implements tunnel behavior.
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  appendBoundedChildOutput,
  emptyBoundedChildOutput,
  formatBoundedChildOutput,
} from "./bounded-child-output.js";
import { getTailscaleDnsName } from "./webhook/tailscale.js";

const NGROK_LOG_BUFFER_MAX_CHARS = 16_384;
const NGROK_ERROR_MARKER = "ERR_NGROK";
const NGROK_STDERR_TAIL_MAX_CHARS = NGROK_ERROR_MARKER.length - 1;
const TUNNEL_COMMAND_OUTPUT_MAX_BYTES = 16_384;
const NGROK_STOP_GRACE_MS = 2_000;
const NGROK_FORCE_KILL_WAIT_MS = 1_000;

async function terminateNgrokProcess(
  proc: Pick<ChildProcess, "kill" | "once" | "off">,
  isClosed: () => boolean,
): Promise<void> {
  if (isClosed()) {
    return;
  }
  await new Promise<void>((resolve) => {
    let finished = false;
    let forceKillWaitTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (forceKillWaitTimer) {
        clearTimeout(forceKillWaitTimer);
      }
      proc.off("close", finish);
      resolve();
    };
    proc.once("close", finish);
    // Give ngrok a graceful window before forcing termination. The final bounded
    // close wait avoids returning before SIGKILL normally reaps the child without
    // letting an unobservable close event hang cleanup forever.
    const forceKillTimer = setTimeout(() => {
      forceKillWaitTimer = setTimeout(finish, NGROK_FORCE_KILL_WAIT_MS);
      if (!isClosed()) {
        proc.kill("SIGKILL");
      }
    }, NGROK_STOP_GRACE_MS);
    proc.kill("SIGTERM");
    if (isClosed()) {
      finish();
    }
  });
}

function listenForChildStreamErrors(
  proc: Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr">,
  onError: (stream: "stdout" | "stderr", error: Error) => void,
): void {
  // Keep both listeners for the child lifetime: a late unhandled stream error
  // would otherwise escape after the startup promise has already settled.
  proc.stdout.on("error", (error) => onError("stdout", error));
  proc.stderr.on("error", (error) => onError("stderr", error));
}

/**
 * Tunnel configuration for exposing the webhook server.
 */
interface TunnelConfig {
  /** Tunnel provider: ngrok, tailscale-serve, or tailscale-funnel */
  provider: "ngrok" | "tailscale-serve" | "tailscale-funnel" | "none";
  /** Local port to tunnel */
  port: number;
  /** Path prefix for the tunnel (e.g., /voice/webhook) */
  path: string;
  /** ngrok auth token (optional, enables longer sessions) */
  ngrokAuthToken?: string;
  /** ngrok custom domain (paid feature) */
  ngrokDomain?: string;
}

/**
 * Result of starting a tunnel.
 */
export interface TunnelResult {
  /** The public URL */
  publicUrl: string;
  /** Function to stop the tunnel */
  stop: () => Promise<void>;
  /** Tunnel provider name */
  provider: string;
}

/**
 * Start an ngrok tunnel to expose the local webhook server.
 *
 * Uses the ngrok CLI which must be installed: https://ngrok.com/download
 *
 * @example
 * const tunnel = await startNgrokTunnel({ port: 3334, path: '/voice/webhook' });
 * console.log('Public URL:', tunnel.publicUrl);
 * // Later: await tunnel.stop();
 */
async function startNgrokTunnel(config: {
  port: number;
  path: string;
  authToken?: string;
  domain?: string;
}): Promise<TunnelResult> {
  // Set auth token if provided
  if (config.authToken) {
    await runNgrokCommand(["config", "add-authtoken", config.authToken]);
  }

  // Build ngrok command args
  const args = ["http", String(config.port), "--log", "stdout", "--log-format", "json"];

  // Add custom domain if provided (paid ngrok feature)
  if (config.domain) {
    args.push("--domain", config.domain);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn("ngrok", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Startup settlement and OS process closure are separate: the deadline can
    // win before the child has been reaped.
    let startupSettled = false;
    let childClosed = false;
    let publicUrl: string | null = null;
    let outputBuffer = "";
    // Keep only enough UTF-16-safe suffix to recognize an error marker split
    // at the next stream chunk boundary; otherwise the caller loses the code.
    let stderrTail = "";

    const timeout = setTimeout(() => {
      if (!startupSettled) {
        startupSettled = true;
        void terminateNgrokProcess(proc, () => childClosed).then(() => {
          reject(new Error("ngrok startup timed out (30s)"));
        });
      }
    }, 30000);
    // Do not keep the host process alive solely waiting on ngrok startup.
    timeout.unref();

    const rejectIfPending = (message: string, kill = false) => {
      if (!startupSettled) {
        startupSettled = true;
        clearTimeout(timeout);
        if (kill && !childClosed) {
          proc.kill("SIGKILL");
        }
        reject(new Error(message));
      }
    };

    const processLine = (line: string) => {
      try {
        const log = JSON.parse(line);

        // ngrok logs the public URL in a 'started tunnel' message
        if (log.msg === "started tunnel" && log.url) {
          publicUrl = log.url;
        }

        // Also check for the URL field directly
        if (log.addr && log.url && !publicUrl) {
          publicUrl = log.url;
        }

        // Check for ready state
        if (publicUrl && !startupSettled) {
          startupSettled = true;
          clearTimeout(timeout);

          // Add path to the public URL
          const fullUrl = publicUrl + config.path;

          console.log(`[voice-call] ngrok tunnel active: ${fullUrl}`);

          resolve({
            publicUrl: fullUrl,
            provider: "ngrok",
            stop: async () => {
              await terminateNgrokProcess(proc, () => childClosed);
            },
          });
        }
      } catch {
        // Not JSON, might be startup message
      }
    };

    // Decode pipes statefully so a multibyte UTF-8 code point split across
    // chunk boundaries does not become U+FFFD in startup logs / ERR_NGROK text.
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      const lines = (outputBuffer + chunk).split("\n");
      outputBuffer = lines.pop() || "";
      if (outputBuffer.length > NGROK_LOG_BUFFER_MAX_CHARS) {
        // Same UTF-16 contract as appendBoundedChildOutput: do not leave a lone
        // surrogate when an incomplete ngrok log line is trimmed to the ring cap.
        outputBuffer = sliceUtf16Safe(outputBuffer, -NGROK_LOG_BUFFER_MAX_CHARS);
      }

      for (const line of lines) {
        if (line.trim()) {
          processLine(line);
        }
      }
    });
    proc.stderr.on("data", (chunk: string) => {
      const combined = stderrTail + chunk;
      if (combined.includes(NGROK_ERROR_MARKER)) {
        rejectIfPending(
          `ngrok error: ${formatBoundedChildOutput(
            appendBoundedChildOutput(emptyBoundedChildOutput(), combined),
          )}`,
          true,
        );
      }
      stderrTail = sliceUtf16Safe(combined, -NGROK_STDERR_TAIL_MAX_CHARS);
    });
    listenForChildStreamErrors(proc, (stream, error) => {
      rejectIfPending(`ngrok ${stream} error: ${error.message}`, true);
    });

    proc.on("error", (err) => {
      rejectIfPending(`Failed to start ngrok: ${err.message}`);
    });

    proc.on("close", (code) => {
      childClosed = true;
      if (!startupSettled) {
        startupSettled = true;
        clearTimeout(timeout);
        reject(new Error(`ngrok exited unexpectedly with code ${code}`));
      }
    });
  });
}

/**
 * Run an ngrok command and wait for completion.
 */
async function runNgrokCommand(args: string[]): Promise<string> {
  const result = await runCommandWithTimeout(["ngrok", ...args], {
    killProcessTree: true,
    maxOutputBytes: TUNNEL_COMMAND_OUTPUT_MAX_BYTES,
    outputCapture: "tail",
    timeoutMs: 30_000,
  });
  if (result.termination === "timeout") {
    throw new Error("ngrok command timed out");
  }
  if (result.code === 0) {
    return result.stdout;
  }
  const output = result.stderr
    ? { text: result.stderr, truncated: Boolean(result.stderrTruncatedBytes) }
    : { text: result.stdout, truncated: Boolean(result.stdoutTruncatedBytes) };
  throw new Error(`ngrok command failed: ${formatBoundedChildOutput(output)}`);
}

/**
 * Start a Tailscale serve/funnel tunnel.
 */
async function startTailscaleTunnel(config: {
  mode: "serve" | "funnel";
  port: number;
  path: string;
}): Promise<TunnelResult> {
  // Get Tailscale DNS name
  const dnsName = await getTailscaleDnsName();
  if (!dnsName) {
    throw new Error("Could not get Tailscale DNS name. Is Tailscale running?");
  }

  const path = config.path.startsWith("/") ? config.path : `/${config.path}`;
  const localUrl = `http://127.0.0.1:${config.port}${path}`;

  const result = await runCommandWithTimeout(
    ["tailscale", config.mode, "--bg", "--yes", "--set-path", path, localUrl],
    {
      killProcessTree: true,
      maxOutputBytes: TUNNEL_COMMAND_OUTPUT_MAX_BYTES,
      outputCapture: "tail",
      timeoutMs: 10_000,
    },
  );
  if (result.termination === "timeout") {
    throw new Error(`Tailscale ${config.mode} timed out`);
  }
  if (result.code !== 0) {
    const output = result.stderr
      ? { text: result.stderr, truncated: Boolean(result.stderrTruncatedBytes) }
      : { text: result.stdout, truncated: Boolean(result.stdoutTruncatedBytes) };
    const detail = output.text ? `: ${formatBoundedChildOutput(output)}` : "";
    throw new Error(`Tailscale ${config.mode} failed with code ${result.code}${detail}`);
  }
  const publicUrl = `https://${dnsName}${path}`;
  console.log(`[voice-call] Tailscale ${config.mode} active: ${publicUrl}`);

  return {
    publicUrl,
    provider: `tailscale-${config.mode}`,
    stop: async () => {
      await stopTailscaleTunnel(config.mode, path);
    },
  };
}

/**
 * Stop a Tailscale serve/funnel tunnel.
 */
async function stopTailscaleTunnel(mode: "serve" | "funnel", path: string): Promise<void> {
  await runCommandWithTimeout(["tailscale", mode, "off", path], {
    killProcessTree: true,
    maxOutputBytes: 1,
    timeoutMs: 5_000,
  }).catch(() => {});
}

/**
 * Start a tunnel based on configuration.
 */
export async function startTunnel(config: TunnelConfig): Promise<TunnelResult | null> {
  switch (config.provider) {
    case "ngrok":
      return startNgrokTunnel({
        port: config.port,
        path: config.path,
        authToken: config.ngrokAuthToken,
        domain: config.ngrokDomain,
      });

    case "tailscale-serve":
      return startTailscaleTunnel({
        mode: "serve",
        port: config.port,
        path: config.path,
      });

    case "tailscale-funnel":
      return startTailscaleTunnel({
        mode: "funnel",
        port: config.port,
        path: config.path,
      });

    default:
      return null;
  }
}
