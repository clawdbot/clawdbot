// Port inspection and force-free helpers used by gateway run/install flows.
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { formatErrorMessage } from "../infra/errors.js";
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import { resolveLsofCommandSync } from "../infra/ports-lsof.js";
import { parseWindowsNetstatListeners } from "../infra/ports-netstat.js";
import { probePortUsage } from "../infra/ports-probe.js";
import { getWindowsSystem32ExePath } from "../infra/windows-install-roots.js";
import { resolvePositiveTimerTimeoutMs, resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import { sleep } from "../utils.js";

type PortProcess = { pid: number; command?: string };

type ForceFreePortResult = {
  killed: PortProcess[];
  waitedMs: number;
  escalatedToSigkill: boolean;
};

type BeforePortSignal = (context: { port: number; pid?: number; signal: NodeJS.Signals }) => void;

type ExecFileError = NodeJS.ErrnoException & {
  status?: number | null;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
  cause?: unknown;
};

const FUSER_SIGNALS: Record<"SIGTERM" | "SIGKILL", string> = {
  SIGTERM: "TERM",
  SIGKILL: "KILL",
};
// Node waits for synchronous children to exit after a timeout signal.
// SIGKILL keeps a tool from ignoring the startup deadline.
const PORT_TOOL_TIMEOUT_MS = 10_000;

function readExecOutput(value: string | Buffer | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Buffer) {
    return value.toString("utf8");
  }
  return "";
}

function withErrnoCode(message: string, code: string, cause: unknown): Error {
  const out = new Error(message, { cause: cause instanceof Error ? cause : undefined }) as Error &
    NodeJS.ErrnoException;
  out.code = code;
  return out;
}

function getErrnoCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === "string" && direct.length > 0) {
    return direct;
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const nested = (cause as { code?: unknown }).code;
    if (typeof nested === "string" && nested.length > 0) {
      return nested;
    }
  }
  return undefined;
}

function isRecoverableLsofError(err: unknown): boolean {
  // Permission, missing-binary, or malformed-output failures can fall back to fuser on Linux.
  const code = getErrnoCode(err);
  if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "EPROTO") {
    return true;
  }
  const message = formatErrorMessage(err);
  return /lsof.*(permission denied|not permitted|operation not permitted|eacces|eperm)/i.test(
    message,
  );
}

function parseFuserPidList(output: string): number[] {
  if (!output) {
    return [];
  }
  const values = new Set<number>();
  for (const token of output.split(/\s+/)) {
    if (!token) {
      continue;
    }
    const pid = parseStrictPositiveInteger(token);
    if (pid !== undefined) {
      values.add(pid);
    }
  }
  return [...values];
}

function killPortWithFuser(
  port: number,
  signal: "SIGTERM" | "SIGKILL",
  beforeSignal?: BeforePortSignal,
): PortProcess[] {
  if (beforeSignal) {
    const listeners = listPortListenersWithFuser(port);
    // fuser's resource-targeted -k can select a different PID at exec time.
    // A guard therefore freezes concrete victims before signaling directly.
    killPids(port, listeners, signal, beforeSignal);
    return listeners;
  }
  const args = ["-k", `-${FUSER_SIGNALS[signal]}`, `${port}/tcp`];
  try {
    const stdout = execFileSync("fuser", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PORT_TOOL_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return parseFuserPidList(stdout).map((pid) => ({ pid }));
  } catch (err: unknown) {
    const execErr = err as ExecFileError;
    const code = execErr.code;
    const status = execErr.status;
    const stdout = readExecOutput(execErr.stdout);
    const stderr = readExecOutput(execErr.stderr);
    const parsed = parseFuserPidList([stdout, stderr].filter(Boolean).join("\n"));
    if (status === 1) {
      // fuser exits 1 if nothing matched; keep any parsed PIDs in case signal succeeded.
      return parsed.map((pid) => ({ pid }));
    }
    if (code === "ENOENT") {
      throw withErrnoCode(
        "fuser not found; required for --force when lsof is unavailable",
        "ENOENT",
        err,
      );
    }
    if (code === "EACCES" || code === "EPERM") {
      throw withErrnoCode("fuser permission denied while forcing gateway port", code, err);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function listPortListenersWithFuser(port: number): PortProcess[] {
  try {
    const stdout = execFileSync("fuser", [`${port}/tcp`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PORT_TOOL_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return parseFuserPidList(stdout).map((pid) => ({ pid }));
  } catch (err: unknown) {
    const execErr = err as ExecFileError;
    const stdout = readExecOutput(execErr.stdout);
    // fuser writes resource labels and diagnostics to stderr. Only its stdout
    // PID stream is safe to turn into direct signal targets.
    const parsed = parseFuserPidList(stdout);
    if (execErr.status === 1) {
      return parsed.map((pid) => ({ pid }));
    }
    if (execErr.code === "ENOENT") {
      throw withErrnoCode(
        "fuser not found; required for --force when lsof is unavailable",
        "ENOENT",
        err,
      );
    }
    if (execErr.code === "EACCES" || execErr.code === "EPERM") {
      throw withErrnoCode(
        "fuser permission denied while inspecting gateway port",
        execErr.code,
        err,
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

async function isPortBusy(port: number): Promise<boolean> {
  // Route through probePortUsage which probes all four endpoints
  // (127.0.0.1, 0.0.0.0, ::1, ::) instead of a single hostless bind
  // that defaults to IPv6 wildcard and misses IPv4-only occupants.
  // Treat "unknown" as busy — inconclusive probe failures must not cause
  // forceFreePortAndWait to exit early before lsof/fuser can inspect.
  return (await probePortUsage(port)) !== "free";
}

function parseLsofOutput(output: string): PortProcess[] {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const results: PortProcess[] = [];
  let current: Partial<PortProcess> = {};
  for (const line of lines) {
    if (line.startsWith("p")) {
      if (current.pid) {
        results.push(current as PortProcess);
      }
      const rawPidToken = line.slice(1);
      const rawPid = parseStrictPositiveInteger(rawPidToken);
      if (rawPid === undefined) {
        throw withErrnoCode(
          `lsof returned malformed PID field: ${JSON.stringify(rawPidToken)}`,
          "EPROTO",
          undefined,
        );
      }
      current = { pid: rawPid };
    } else if (line.startsWith("c")) {
      current.command = line.slice(1);
    }
  }
  if (current.pid) {
    results.push(current as PortProcess);
  }
  return results;
}

function listPortListeners(port: number): PortProcess[] {
  if (process.platform === "win32") {
    try {
      const out = execFileSync(getWindowsSystem32ExePath("netstat.exe"), ["-ano"], {
        encoding: "utf-8",
        timeout: PORT_TOOL_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      const listeners = parseWindowsNetstatListeners(out, port);
      const seenPids = new Set<number>();
      const results: PortProcess[] = [];
      for (const listener of listeners) {
        if (seenPids.has(listener.pid)) {
          continue;
        }
        seenPids.add(listener.pid);
        results.push({ pid: listener.pid });
      }
      return results;
    } catch (err: unknown) {
      throw new Error(`netstat failed: ${String(err)}`, { cause: err });
    }
  }

  try {
    const lsof = resolveLsofCommandSync();
    const out = execFileSync(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-FpFc"], {
      encoding: "utf-8",
      timeout: PORT_TOOL_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return parseLsofOutput(out);
  } catch (err: unknown) {
    const execErr = err as ExecFileError;
    const status = execErr.status ?? undefined;
    const code = execErr.code;
    if (code === "ENOENT") {
      throw withErrnoCode("lsof not found; required for --force", "ENOENT", err);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw withErrnoCode("lsof permission denied while inspecting gateway port", code, err);
    }
    if (status === 1) {
      const stderr = readExecOutput(execErr.stderr).trim();
      if (
        stderr &&
        /permission denied|not permitted|operation not permitted|can't stat/i.test(stderr)
      ) {
        throw withErrnoCode(
          `lsof permission denied while inspecting gateway port: ${stderr}`,
          "EACCES",
          err,
        );
      }
      return [];
    } // no listeners
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export function forceFreePort(
  port: number,
  opts: { beforeSignal?: BeforePortSignal } = {},
): PortProcess[] {
  const listeners = listPortListeners(port);
  killPids(port, listeners, "SIGTERM", opts.beforeSignal);
  return listeners;
}

function killPids(
  port: number,
  listeners: PortProcess[],
  signal: NodeJS.Signals,
  beforeSignal?: BeforePortSignal,
) {
  for (const proc of listeners) {
    try {
      beforeSignal?.({ port, pid: proc.pid, signal });
      process.kill(proc.pid, signal);
    } catch (err) {
      throw new Error(
        `failed to kill pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""}: ${String(err)}`,
        { cause: err },
      );
    }
  }
}

export async function forceFreePortAndWait(
  port: number,
  opts: {
    /** Total wait budget across signals. */
    timeoutMs?: number;
    /** Poll interval for checking whether lsof reports listeners. */
    intervalMs?: number;
    /** How long to wait after SIGTERM before escalating to SIGKILL. */
    sigtermTimeoutMs?: number;
    /** Last-moment ownership guard invoked before each destructive signal. */
    beforeSignal?: BeforePortSignal;
  } = {},
): Promise<ForceFreePortResult> {
  const timeoutMs = resolveTimerTimeoutMs(opts.timeoutMs, 1500, 0);
  const intervalMs = resolvePositiveTimerTimeoutMs(opts.intervalMs, 100);
  const sigtermTimeoutMs = Math.min(
    resolveTimerTimeoutMs(opts.sigtermTimeoutMs, 600, 0),
    timeoutMs,
  );

  let killed: PortProcess[] = [];
  let useFuserFallback = false;

  try {
    killed = forceFreePort(port, opts.beforeSignal ? { beforeSignal: opts.beforeSignal } : {});
  } catch (err) {
    if (!isRecoverableLsofError(err)) {
      throw err;
    }
    // Keep --force usable on minimal systems when the bind probe can confirm
    // the port is free; otherwise use fuser to cover listeners lsof cannot inspect.
    if (!(await isPortBusy(port))) {
      return { killed, waitedMs: 0, escalatedToSigkill: false };
    }
    useFuserFallback = true;
    killed = killPortWithFuser(port, "SIGTERM", opts.beforeSignal);
  }

  if (killed.length === 0) {
    if (await isPortBusy(port)) {
      throw new Error(
        `port ${port} is still busy after --force, but no listener PID could be determined`,
      );
    }
    return { killed, waitedMs: 0, escalatedToSigkill: false };
  }

  const checkBusy = async (): Promise<boolean> =>
    useFuserFallback ? isPortBusy(port) : listPortListeners(port).length > 0;

  if (!(await checkBusy())) {
    return { killed, waitedMs: 0, escalatedToSigkill: false };
  }

  let waitedMs = 0;
  while (waitedMs < sigtermTimeoutMs) {
    if (!(await checkBusy())) {
      return { killed, waitedMs, escalatedToSigkill: false };
    }
    const sleepMs = Math.min(intervalMs, sigtermTimeoutMs - waitedMs);
    await sleep(sleepMs);
    waitedMs += sleepMs;
  }

  if (!(await checkBusy())) {
    return { killed, waitedMs, escalatedToSigkill: false };
  }

  if (useFuserFallback) {
    killPortWithFuser(port, "SIGKILL", opts.beforeSignal);
  } else {
    const remaining = listPortListeners(port);
    killPids(port, remaining, "SIGKILL", opts.beforeSignal);
  }

  while (waitedMs < timeoutMs) {
    if (!(await checkBusy())) {
      return { killed, waitedMs, escalatedToSigkill: true };
    }
    const sleepMs = Math.min(intervalMs, timeoutMs - waitedMs);
    await sleep(sleepMs);
    waitedMs += sleepMs;
  }

  if (!(await checkBusy())) {
    return { killed, waitedMs, escalatedToSigkill: true };
  }

  if (useFuserFallback) {
    throw new Error(`port ${port} still has listeners after --force (fuser fallback)`);
  }
  const still = listPortListeners(port);
  throw new Error(
    `port ${port} still has listeners after --force: ${still.map((p) => p.pid).join(", ")}`,
  );
}

/**
 * Attempt a real TCP bind to verify the port is available at the OS level.
 * Catches TIME_WAIT / kernel-level holds that lsof won't show.
 *
 * Resolves false only for EADDRINUSE — a genuinely transient condition
 * (port still in TIME_WAIT after a --force kill) that the caller should retry.
 *
 * All other errors are non-retryable and are rejected immediately:
 * - EADDRNOTAVAIL: the host address doesn't exist on any local interface
 *   (hard misconfiguration, not a transient kernel hold).
 * - EACCES: bind to a privileged port as non-root.
 * - EINVAL, etc.: other unrecoverable OS errors.
 */
function probePortFree(port: number, host = "0.0.0.0"): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", (err: NodeJS.ErrnoException) => {
      srv.close();
      if (err.code === "EADDRINUSE") {
        // Genuinely transient — port still in use or TIME_WAIT after a --force kill.
        resolve(false);
      } else {
        // Non-retryable: EADDRNOTAVAIL (bad host address), EACCES (privileged port),
        // EINVAL, and any other OS errors. Surface immediately; no retry loop.
        reject(err);
      }
    });
    srv.listen(port, host, () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Poll until a real test-bind succeeds, up to `timeoutMs`.
 * Returns the number of ms waited, or throws if the port never freed.
 */
export async function waitForPortBindable(
  port: number,
  opts: { timeoutMs?: number; intervalMs?: number; host?: string } = {},
): Promise<number> {
  const timeoutMs = resolveTimerTimeoutMs(opts.timeoutMs, 3000, 0);
  const intervalMs = resolvePositiveTimerTimeoutMs(opts.intervalMs, 150);
  const host = opts.host;
  let waited = 0;
  while (waited < timeoutMs) {
    if (await probePortFree(port, host)) {
      return waited;
    }
    const sleepMs = Math.min(intervalMs, timeoutMs - waited);
    await sleep(sleepMs);
    waited += sleepMs;
  }
  // Final attempt
  if (await probePortFree(port, host)) {
    return waited;
  }
  throw new Error(`port ${port} still not bindable after ${waited}ms (TIME_WAIT or kernel hold)`);
}
