// Qa Lab plugin module owns gateway child process lifecycle behavior.
import type { ChildProcess } from "node:child_process";
import type { WriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { QaSuiteInfraError } from "./errors.js";
import { formatQaGatewayLogsForError, redactQaGatewayDebugText } from "./gateway-log-redaction.js";
import {
  inspectLinuxProcessGroup,
  type QaLinuxProcessGroupInspector,
} from "./posix-process-group.js";
import { runQaWindowsTaskkill } from "./windows-system-tools.js";

const QA_GATEWAY_CHILD_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000;
const QA_GATEWAY_CHILD_FORCE_SHUTDOWN_TIMEOUT_MS = 10_000;
const QA_GATEWAY_LOG_CLOSE_TIMEOUT_MS = 5_000;
const QA_GATEWAY_CHILD_RECENT_LOG_CHARS = 64 * 1_024;
const QA_GATEWAY_CHILD_LOG_TRUNCATION_MARKER = "[qa-lab] older gateway logs truncated\n";
const QA_GATEWAY_PROCESS_BOUNDARY_LOG_TAIL_CHARS = 8_192;

export type QaChildFailure = {
  source: "process" | "stdout" | "stderr";
  error: unknown;
};

type QaGatewayChildLogSource = "internal" | "stderr" | "stdout";

export function hasQaGatewayChildExited(child: Pick<ChildProcess, "exitCode" | "signalCode">) {
  return child.exitCode !== null || child.signalCode !== null;
}

export function monitorQaChildFailure(
  child: ChildProcess,
  onFailure: (failure: QaChildFailure) => void,
) {
  let reported = false;
  const report = (source: QaChildFailure["source"]) => (error: unknown) => {
    if (reported) {
      return;
    }
    reported = true;
    onFailure({ source, error });
  };
  child.once("error", report("process"));
  child.stdout?.once("error", report("stdout"));
  child.stderr?.once("error", report("stderr"));
}

export async function closeQaGatewayLogStream(
  stream: WriteStream,
  label: "stderr" | "stdout",
  timeoutMs = QA_GATEWAY_LOG_CLOSE_TIMEOUT_MS,
) {
  if (stream.destroyed) {
    return;
  }
  stream.end();
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    await finished(stream, { cleanup: true, signal });
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
    // Gateway logs are diagnostic only. Never let a stuck filesystem flush
    // retain the stopped child runtime and its live transport credentials.
    process.stderr.write(
      `[qa-suite] ${label} gateway log flush exceeded ${timeoutMs}ms; forcing close\n`,
    );
    stream.destroy();
  }
}

export function createQaGatewayChildLogCollector() {
  const decoders: Record<QaGatewayChildLogSource, StringDecoder> = {
    internal: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
    stdout: new StringDecoder("utf8"),
  };
  let recent = "";
  let end = 0;

  const readFrom = (mark: number) => {
    const start = end - recent.length;
    const wasTruncated = mark < start;
    const text = recent.slice(Math.max(0, mark - start));
    return `${wasTruncated ? QA_GATEWAY_CHILD_LOG_TRUNCATION_MARKER : ""}${text}`;
  };
  return {
    push(source: QaGatewayChildLogSource, chunk: Buffer) {
      const text = decoders[source].write(chunk);
      end += text.length;
      recent += text;
      if (recent.length > QA_GATEWAY_CHILD_RECENT_LOG_CHARS) {
        recent = sliceUtf16Safe(recent, -QA_GATEWAY_CHILD_RECENT_LOG_CHARS);
      }
    },
    mark() {
      return end;
    },
    readSince(mark: number) {
      return readFrom(mark);
    },
    text() {
      return `${end > recent.length ? QA_GATEWAY_CHILD_LOG_TRUNCATION_MARKER : ""}${recent}`.trim();
    },
  };
}

function formatQaGatewayChildFailure(failure: QaChildFailure) {
  return failure.source === "process"
    ? `gateway failed to spawn: ${formatErrorMessage(failure.error)}`
    : `gateway child ${failure.source} stream failed: ${formatErrorMessage(failure.error)}`;
}

export function throwQaGatewayChildFailure(
  getChildFailure: (() => QaChildFailure | null) | undefined,
  logs: () => string,
) {
  const failure = getChildFailure?.();
  if (!failure) {
    return;
  }
  throw new QaSuiteInfraError(
    "gateway_startup_unhealthy",
    `${formatQaGatewayChildFailure(failure)}\n${logs()}`,
    { cause: failure.error },
  );
}

export function monitorQaGatewayChildFailure(
  child: ChildProcess,
  output: { push(source: QaGatewayChildLogSource, chunk: Buffer): void },
) {
  let childFailure: QaChildFailure | null = null;
  monitorQaChildFailure(child, (failure) => {
    childFailure = failure;
    const description =
      failure.source === "process"
        ? `gateway child process error: ${formatErrorMessage(failure.error)}`
        : formatQaGatewayChildFailure(failure);
    output.push("internal", Buffer.from(`[qa-lab] ${description}\n`));
    if (failure.source !== "process" && !hasQaGatewayChildExited(child)) {
      // A broken parent-side pipe means QA can no longer observe the Gateway.
      // Stop the detached process tree so the existing lifecycle reports the failure.
      signalQaGatewayChildProcessTree(child, "SIGTERM");
    }
  });
  return () => childFailure;
}

export function formatQaGatewayProcessBoundaryStartupFailure(error: unknown, logs: string) {
  const logTail = sliceUtf16Safe(
    redactQaGatewayDebugText(logs),
    -QA_GATEWAY_PROCESS_BOUNDARY_LOG_TAIL_CHARS,
  );
  return `${formatErrorMessage(error)}${formatQaGatewayLogsForError(logTail)}`;
}

function isProcessAlreadyExitedError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ESRCH";
}

function boundQaGatewayProcessTreeDiagnostics(details: string) {
  if (details.length <= 2_048) {
    return details;
  }
  return `${sliceUtf16Safe(details, 0, 2_045)}...`;
}

function isQaGatewayChildProcessTreeAlive(
  child: ChildProcess,
  inspectLinuxProcessGroupFn: QaLinuxProcessGroupInspector = inspectLinuxProcessGroup,
) {
  if (!child.pid) {
    return false;
  }
  if (process.platform === "win32") {
    return !hasQaGatewayChildExited(child);
  }
  try {
    process.kill(-child.pid, 0);
    if (process.platform === "linux") {
      // Linux can retain zombie-only process groups after SIGKILL while Node's
      // child metadata is still unsettled. Runnable /proc members are the owner.
      return inspectLinuxProcessGroupFn(child.pid)?.alive ?? true;
    }
    return true;
  } catch (error) {
    if (!isProcessAlreadyExitedError(error) && !hasQaGatewayChildExited(child)) {
      return true;
    }
  }
  return false;
}

function signalQaGatewayChildProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      if (runQaWindowsTaskkill({ pid: child.pid, signal })) {
        return;
      }
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  }
}

async function waitForQaGatewayChildExit(
  child: ChildProcess,
  timeoutMs: number,
  inspectLinuxProcessGroupFn: QaLinuxProcessGroupInspector,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isQaGatewayChildProcessTreeAlive(child, inspectLinuxProcessGroupFn)) {
      return true;
    }
    await sleep(Math.min(25, Math.max(0, deadline - Date.now())));
  }
  return !isQaGatewayChildProcessTreeAlive(child, inspectLinuxProcessGroupFn);
}

type QaGatewayChildStopOptions = {
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
  inspectLinuxProcessGroup?: QaLinuxProcessGroupInspector;
};

function resolveQaGatewayChildStopTimeouts(opts?: QaGatewayChildStopOptions) {
  return {
    gracefulTimeoutMs: opts?.gracefulTimeoutMs ?? QA_GATEWAY_CHILD_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
    forceTimeoutMs: opts?.forceTimeoutMs ?? QA_GATEWAY_CHILD_FORCE_SHUTDOWN_TIMEOUT_MS,
  };
}

function formatQaGatewayProcessTreeDiagnostics(
  child: ChildProcess,
  inspectLinuxProcessGroupFn: QaLinuxProcessGroupInspector,
) {
  const childExitRecorded = hasQaGatewayChildExited(child);
  if (process.platform !== "linux" || !child.pid) {
    return `pid=${child.pid ?? "unknown"} childExitRecorded=${childExitRecorded}`;
  }
  const inspection = inspectLinuxProcessGroupFn(child.pid);
  const processGroupDetails =
    inspection?.diagnostics ?? `pgid=${child.pid} members=unknown (/proc unavailable)`;
  return boundQaGatewayProcessTreeDiagnostics(
    `${processGroupDetails} childExitRecorded=${childExitRecorded}`,
  );
}

export async function stopQaGatewayChildProcessTree(
  child: ChildProcess,
  opts?: QaGatewayChildStopOptions,
) {
  const inspectLinuxProcessGroupFn = opts?.inspectLinuxProcessGroup ?? inspectLinuxProcessGroup;
  if (!isQaGatewayChildProcessTreeAlive(child, inspectLinuxProcessGroupFn)) {
    return;
  }
  const timeouts = resolveQaGatewayChildStopTimeouts(opts);
  signalQaGatewayChildProcessTree(child, "SIGTERM");
  if (
    await waitForQaGatewayChildExit(child, timeouts.gracefulTimeoutMs, inspectLinuxProcessGroupFn)
  ) {
    return;
  }
  signalQaGatewayChildProcessTree(child, "SIGKILL");
  const stopped = await waitForQaGatewayChildExit(
    child,
    timeouts.forceTimeoutMs,
    inspectLinuxProcessGroupFn,
  );
  if (!stopped) {
    throw new Error(
      `qa gateway process tree remained alive after forced shutdown: ${formatQaGatewayProcessTreeDiagnostics(
        child,
        inspectLinuxProcessGroupFn,
      )}`,
    );
  }
}
