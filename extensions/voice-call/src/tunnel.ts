// Voice Call plugin module implements tunnel behavior.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  appendBoundedChildOutput,
  emptyBoundedChildOutput,
  formatBoundedChildOutput,
} from "./bounded-child-output.js";
import { getTailscaleDnsName } from "./webhook/tailscale.js";

const NGROK_LOG_BUFFER_MAX_CHARS = 16_384;

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
export async function startNgrokTunnel(config: {
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

    let resolved = false;
    let closed = false;
    let publicUrl: string | null = null;
    let outputBuffer = "";

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill("SIGTERM");
        reject(new Error("ngrok startup timed out (30s)"));
      }
    }, 30000);

    const rejectIfPending = (message: string, kill = false) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        if (kill && !closed) {
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
        if (publicUrl && !resolved) {
          resolved = true;
          clearTimeout(timeout);

          // Add path to the public URL
          const fullUrl = publicUrl + config.path;

          console.log(`[voice-call] ngrok tunnel active: ${fullUrl}`);

          resolve({
            publicUrl: fullUrl,
            provider: "ngrok",
            stop: async () => {
              if (closed) {
                return;
              }
              await new Promise<void>((res) => {
                let finished = false;
                const finish = () => {
                  if (finished) {
                    return;
                  }
                  finished = true;
                  clearTimeout(fallback);
                  proc.off("close", finish);
                  res();
                };
                if (closed) {
                  res();
                  return;
                }
                proc.once("close", finish);
                const fallback = setTimeout(finish, 2000);
                proc.kill("SIGTERM");
                if (closed) {
                  finish();
                }
              });
            },
          });
        }
      } catch {
        // Not JSON, might be startup message
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      const lines = (outputBuffer + data.toString()).split("\n");
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
    proc.stderr.on("data", (data: Buffer) => {
      const msg = data.toString();
      // Check for common errors
      if (msg.includes("ERR_NGROK")) {
        rejectIfPending(
          `ngrok error: ${formatBoundedChildOutput(
            appendBoundedChildOutput(emptyBoundedChildOutput(), msg),
          )}`,
          true,
        );
      }
    });
    listenForChildStreamErrors(proc, (stream, error) => {
      rejectIfPending(`ngrok ${stream} error: ${error.message}`, true);
    });

    proc.on("error", (err) => {
      rejectIfPending(`Failed to start ngrok: ${err.message}`);
    });

    proc.on("close", (code) => {
      closed = true;
      if (!resolved) {
        resolved = true;
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
  return new Promise((resolve, reject) => {
    const proc = spawn("ngrok", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = emptyBoundedChildOutput();
    let stderr = emptyBoundedChildOutput();
    let settled = false;

    const rejectIfPending = (error: Error, kill = false) => {
      if (settled) {
        return;
      }
      settled = true;
      if (kill) {
        proc.kill("SIGKILL");
      }
      reject(error);
    };

    proc.stdout.on("data", (data) => {
      stdout = appendBoundedChildOutput(stdout, data.toString());
    });
    proc.stderr.on("data", (data) => {
      stderr = appendBoundedChildOutput(stderr, data.toString());
    });
    listenForChildStreamErrors(proc, (stream, error) => {
      rejectIfPending(new Error(`ngrok command ${stream} error: ${error.message}`), true);
    });

    proc.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (code === 0) {
        resolve(stdout.text);
      } else {
        const output = stderr.text ? stderr : stdout;
        reject(new Error(`ngrok command failed: ${formatBoundedChildOutput(output)}`));
      }
    });

    proc.on("error", (error) => rejectIfPending(error));
  });
}

/**
 * Start a Tailscale serve/funnel tunnel.
 */
export async function startTailscaleTunnel(config: {
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

  return new Promise((resolve, reject) => {
    const proc = spawn("tailscale", [config.mode, "--bg", "--yes", "--set-path", path, localUrl], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let resolved = false;
    let stdout = emptyBoundedChildOutput();
    let stderr = emptyBoundedChildOutput();

    const rejectIfPending = (error: Error, kill = false) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      if (kill) {
        proc.kill("SIGKILL");
      }
      reject(error);
    };

    const timeout = setTimeout(() => {
      rejectIfPending(new Error(`Tailscale ${config.mode} timed out`), true);
    }, 10000);

    proc.stdout.on("data", (data) => {
      stdout = appendBoundedChildOutput(stdout, data.toString());
    });
    proc.stderr.on("data", (data) => {
      stderr = appendBoundedChildOutput(stderr, data.toString());
    });
    listenForChildStreamErrors(proc, (stream, error) => {
      rejectIfPending(
        new Error(`Tailscale ${config.mode} ${stream} error: ${error.message}`),
        true,
      );
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (resolved) {
        return;
      }
      resolved = true;
      if (code === 0) {
        const publicUrl = `https://${dnsName}${path}`;
        console.log(`[voice-call] Tailscale ${config.mode} active: ${publicUrl}`);

        resolve({
          publicUrl,
          provider: `tailscale-${config.mode}`,
          stop: async () => {
            await stopTailscaleTunnel(config.mode, path);
          },
        });
      } else {
        const output = stderr.text ? stderr : stdout;
        const detail = output.text ? `: ${formatBoundedChildOutput(output)}` : "";
        reject(new Error(`Tailscale ${config.mode} failed with code ${code}${detail}`));
      }
    });

    proc.on("error", (err) => {
      rejectIfPending(err);
    });
  });
}

/**
 * Stop a Tailscale serve/funnel tunnel.
 */
async function stopTailscaleTunnel(mode: "serve" | "funnel", path: string): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn("tailscale", [mode, "off", path], {
      stdio: "ignore",
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 5000);

    proc.on("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    proc.on("error", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
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
