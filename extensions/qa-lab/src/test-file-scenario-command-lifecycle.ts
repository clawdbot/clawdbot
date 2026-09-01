import { spawn } from "node:child_process";
import path from "node:path";
import {
  appendQaChildOutput,
  appendQaChildOutputTail,
  createQaChildOutputCapture,
  createQaChildOutputTail,
  QA_CHILD_STDERR_TAIL_BYTES,
  QA_CHILD_STDOUT_MAX_BYTES,
  readQaChildOutput,
  readQaChildOutputTail,
} from "./child-output.js";
import { createQaPosixCommandSettlement } from "./posix-command-settlement.js";
import { runQaWindowsTaskkill } from "./windows-system-tools.js";

export type QaScenarioCommandExecution = {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onOutput?: (stream: "stderr" | "stdout", chunk: Buffer) => void;
  timeoutMs?: number;
};

export type QaScenarioCommandResult = {
  exitCode: number;
  failureMessage?: string;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated?: true;
  stderrTruncated?: true;
};

type QaScenarioCommandTerminalResult = Pick<
  QaScenarioCommandResult,
  "exitCode" | "failureMessage" | "signal"
>;

const QA_SCENARIO_COMMAND_TIMEOUT_KILL_GRACE_MS = 2_000;
const QA_SCENARIO_COMMAND_TIMEOUT_FORCE_SETTLE_MS = 500;
let timeoutKillGraceMs = QA_SCENARIO_COMMAND_TIMEOUT_KILL_GRACE_MS;
let timeoutForceSettleMs = QA_SCENARIO_COMMAND_TIMEOUT_FORCE_SETTLE_MS;

export function runQaScenarioCommandLifecycle(
  execution: QaScenarioCommandExecution,
): Promise<QaScenarioCommandResult> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const child = spawn(execution.command, execution.args, {
      cwd: execution.cwd,
      detached: !isWindows,
      env: execution.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Logs are diagnostics, not native test verdicts: bound retention without
    // failing noisy commands or truncating their live onOutput stream.
    const stdout = createQaChildOutputCapture();
    const stderr = createQaChildOutputTail();
    const commandLabel = path.basename(execution.command);
    createQaPosixCommandSettlement({
      child,
      settlementFailureMessage: `${commandLabel} settlement failed`,
      forceKillAfterMs: timeoutKillGraceMs,
      ...(isWindows
        ? {
            windowsCleanup: {
              signal: (signal: NodeJS.Signals) => {
                try {
                  if (
                    child.pid === undefined ||
                    !runQaWindowsTaskkill({ pid: child.pid, signal })
                  ) {
                    child.kill(signal);
                  }
                  return undefined;
                } catch (error) {
                  return error instanceof Error ? error : new Error(String(error));
                }
              },
            },
          }
        : {}),
      executionTimeoutMs: execution.timeoutMs,
      forwardParentSignals: true,
      initialSignal: "SIGTERM",
      onSettled: (outcome) => {
        const primary = outcome.primary;
        if (primary.type === "spawn-error" || primary.type === "stream-error") {
          reject(
            outcome.settlementFailure
              ? new AggregateError(
                  [primary.error, outcome.settlementFailure],
                  `${commandLabel} command and settlement failed`,
                )
              : primary.error,
          );
          return;
        }
        const result: QaScenarioCommandTerminalResult =
          primary.type === "exit"
            ? {
                exitCode: primary.exitCode ?? (primary.signal ? 1 : 0),
                signal: primary.signal,
              }
            : primary.type === "parent-signal"
              ? {
                  exitCode: 1,
                  failureMessage: `${commandLabel} interrupted by ${primary.signal}`,
                  signal: primary.signal,
                }
              : {
                  exitCode: 1,
                  failureMessage: `${commandLabel} timed out after ${execution.timeoutMs}ms`,
                  signal: null,
                };
        const settlementFailure = outcome.settlementFailure?.message;
        resolve({
          ...result,
          ...(settlementFailure && result.exitCode === 0 ? { exitCode: 1 } : {}),
          stdout: readQaChildOutput(stdout),
          stderr: readQaChildOutputTail(stderr),
          ...(stdout.exceeded ? { stdoutTruncated: true } : {}),
          ...(stderr.truncated ? { stderrTruncated: true } : {}),
          ...(settlementFailure
            ? result.failureMessage
              ? { failureMessage: `${result.failureMessage}; settlement: ${settlementFailure}` }
              : { failureMessage: settlementFailure }
            : {}),
        });
      },
      onStderrData: (chunk) => {
        const buffered = Buffer.from(chunk);
        appendQaChildOutputTail(stderr, buffered);
        execution.onOutput?.("stderr", buffered);
      },
      onStdoutData: (chunk) => {
        const buffered = Buffer.from(chunk);
        appendQaChildOutput(stdout, buffered);
        execution.onOutput?.("stdout", buffered);
      },
      processGroupId: isWindows ? undefined : child.pid,
      verifyAfterMs: timeoutForceSettleMs,
    });
  });
}

export function formatQaScenarioCommandOutput(result: QaScenarioCommandResult): string {
  return [
    result.stdoutTruncated
      ? `[stdout truncated to first ${QA_CHILD_STDOUT_MAX_BYTES} bytes]\n`
      : "",
    result.stdout,
    result.stderrTruncated
      ? `\n[stderr truncated to last ${QA_CHILD_STDERR_TAIL_BYTES} bytes]\n`
      : "",
    result.stderr,
  ].join("");
}

export function resetQaScenarioCommandCleanupTimings() {
  timeoutKillGraceMs = QA_SCENARIO_COMMAND_TIMEOUT_KILL_GRACE_MS;
  timeoutForceSettleMs = QA_SCENARIO_COMMAND_TIMEOUT_FORCE_SETTLE_MS;
}

export function setQaScenarioCommandCleanupTimings(params: {
  forceSettleMs: number;
  killGraceMs: number;
}) {
  timeoutKillGraceMs = params.killGraceMs;
  timeoutForceSettleMs = params.forceSettleMs;
}
