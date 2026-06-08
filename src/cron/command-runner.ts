import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { runCommandWithTimeout } from "../process/exec.js";
import type { CronRunDiagnostics, CronRunOutcome, CronRunStatus, CronJob } from "./types.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
const EFFECTIVELY_UNBOUNDED_TIMEOUT_MS = 2_147_483_647;

function secondsToMs(value: number | undefined): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  if (value <= 0) {
    return EFFECTIVELY_UNBOUNDED_TIMEOUT_MS;
  }
  return finiteSecondsToTimerSafeMilliseconds(value) ?? undefined;
}

function formatCommand(argv: string[]): string {
  return argv.map((arg) => JSON.stringify(arg)).join(" ");
}

function trimOutput(value: string): string | undefined {
  return normalizeOptionalString(value);
}

function buildCommandSummary(params: { stdout: string; stderr: string }): string | undefined {
  const stdout = trimOutput(params.stdout);
  const stderr = trimOutput(params.stderr);
  if (stdout && stderr) {
    return `stdout:\n${stdout}\n\nstderr:\n${stderr}`;
  }
  return stdout ?? stderr;
}

function commandErrorMessage(params: {
  code: number | null;
  signal: NodeJS.Signals | null;
  termination: string;
}): string {
  if (params.termination === "timeout") {
    return "command timed out";
  }
  if (params.termination === "no-output-timeout") {
    return "command produced no output before noOutputTimeoutSeconds";
  }
  if (params.termination === "signal") {
    return params.signal ? `command stopped by signal ${params.signal}` : "command stopped";
  }
  if (typeof params.code === "number") {
    return `command exited with code ${params.code}`;
  }
  return "command failed";
}

function buildDiagnostics(params: {
  command: string;
  status: CronRunStatus;
  summary?: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdoutTruncatedBytes?: number;
  stderrTruncatedBytes?: number;
  nowMs: () => number;
}): CronRunDiagnostics {
  const truncated =
    Boolean(params.stdoutTruncatedBytes && params.stdoutTruncatedBytes > 0) ||
    Boolean(params.stderrTruncatedBytes && params.stderrTruncatedBytes > 0);
  return {
    ...(params.summary ? { summary: params.summary } : {}),
    entries: [
      {
        ts: params.nowMs(),
        source: "exec",
        severity: params.status === "ok" ? "info" : "error",
        message: params.summary
          ? `command ${params.status}: ${params.command}`
          : `command ${params.status} with no output: ${params.command}`,
        exitCode: params.code,
        truncated,
        ...(params.signal ? { toolName: `signal:${params.signal}` } : {}),
      },
    ],
  };
}

/** Executes a cron command payload without starting an agent/model run. */
export async function runCronCommandJob(params: {
  job: CronJob;
  abortSignal?: AbortSignal;
  nowMs?: () => number;
}): Promise<CronRunOutcome> {
  const nowMs = params.nowMs ?? Date.now;
  const { payload } = params.job;
  if (payload.kind !== "command") {
    return {
      status: "skipped",
      error: 'command runner requires payload.kind="command"',
    };
  }
  if (!Array.isArray(payload.argv) || payload.argv.length === 0) {
    return {
      status: "skipped",
      error: 'command payload requires non-empty "argv"',
    };
  }

  const command = formatCommand(payload.argv);
  const noOutputTimeoutMs = secondsToMs(payload.noOutputTimeoutSeconds);
  try {
    const result = await runCommandWithTimeout(payload.argv, {
      timeoutMs: secondsToMs(payload.timeoutSeconds) ?? DEFAULT_COMMAND_TIMEOUT_MS,
      ...(payload.cwd ? { cwd: payload.cwd } : {}),
      ...(payload.input !== undefined ? { input: payload.input } : {}),
      ...(payload.env ? { env: payload.env } : {}),
      ...(noOutputTimeoutMs !== undefined ? { noOutputTimeoutMs } : {}),
      ...(payload.outputMaxBytes !== undefined ? { maxOutputBytes: payload.outputMaxBytes } : {}),
      ...(params.abortSignal ? { signal: params.abortSignal } : {}),
      killProcessTree: true,
    });
    const ok =
      result.code === 0 &&
      !result.killed &&
      result.termination !== "timeout" &&
      result.termination !== "no-output-timeout" &&
      result.termination !== "signal";
    const status: CronRunStatus = ok ? "ok" : "error";
    const summary = buildCommandSummary({ stdout: result.stdout, stderr: result.stderr });
    const error = ok
      ? undefined
      : commandErrorMessage({
          code: result.code,
          signal: result.signal,
          termination: result.termination,
        });
    return {
      status,
      ...(error ? { error } : {}),
      ...(summary ? { summary } : {}),
      diagnostics: buildDiagnostics({
        command,
        status,
        summary,
        code: result.code,
        signal: result.signal,
        stdoutTruncatedBytes: result.stdoutTruncatedBytes,
        stderrTruncatedBytes: result.stderrTruncatedBytes,
        nowMs,
      }),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      error,
      diagnostics: {
        summary: error,
        entries: [
          {
            ts: nowMs(),
            source: "exec",
            severity: "error",
            message: `command failed to start: ${command}: ${error}`,
            exitCode: null,
          },
        ],
      },
    };
  }
}
