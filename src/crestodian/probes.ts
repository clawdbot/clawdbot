import { spawn } from "node:child_process";
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";

export type LocalCommandProbe = {
  command: string;
  found: boolean;
  version?: string;
  error?: string;
};

const LOCAL_COMMAND_PROBE_OUTPUT_MAX_CHARS = 16 * 1024;
const LOCAL_COMMAND_PROBE_KILL_GRACE_MS = 500;

function appendBounded(previous: string, chunk: string, limit: number): string {
  const next = previous + chunk;
  return next.length > limit ? next.slice(-limit) : next;
}

export async function probeLocalCommand(
  command: string,
  args: string[] = ["--version"],
  opts: { outputLimit?: number; timeoutKillGraceMs?: number; timeoutMs?: number } = {},
): Promise<LocalCommandProbe> {
  const timeoutMs = resolveTimerTimeoutMs(opts.timeoutMs, 1_500);
  const outputLimit = opts.outputLimit ?? LOCAL_COMMAND_PROBE_OUTPUT_MAX_CHARS;
  const timeoutKillGraceMs = resolveTimerTimeoutMs(
    opts.timeoutKillGraceMs,
    LOCAL_COMMAND_PROBE_KILL_GRACE_MS,
    0,
  );
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeoutResult = (): LocalCommandProbe => ({
      command,
      found: true,
      error: `timed out after ${timeoutMs}ms`,
    });
    const finish = (result: LocalCommandProbe) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        finish(timeoutResult());
      }, timeoutKillGraceMs);
      killTimer.unref?.();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, String(chunk), outputLimit);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, String(chunk), outputLimit);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({
        command,
        found: err.code !== "ENOENT",
        error: err.code === "ENOENT" ? "not found" : err.message,
      });
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish(timeoutResult());
        return;
      }
      const text = `${stdout}\n${stderr}`.trim().split(/\r?\n/)[0]?.trim();
      finish({
        command,
        found: code === 0 || Boolean(text),
        version: text || undefined,
        error: code === 0 ? undefined : `exited ${String(code)}`,
      });
    });
  });
}

export async function probeGatewayUrl(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ reachable: boolean; url: string; error?: string }> {
  const httpUrl = url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  const healthUrl = new URL("/healthz", httpUrl).toString();
  const timeoutMs = resolveTimerTimeoutMs(opts.timeoutMs, 900);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(healthUrl, {
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
  }
}
