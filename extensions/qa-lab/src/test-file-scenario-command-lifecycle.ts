import { spawn } from "node:child_process";
import path from "node:path";
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
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
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
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          ...(settlementFailure
            ? result.failureMessage
              ? { failureMessage: `${result.failureMessage}; settlement: ${settlementFailure}` }
              : { failureMessage: settlementFailure }
            : {}),
        });
      },
      onStderrData: (chunk) => {
        const buffered = Buffer.from(chunk);
        stderr.push(buffered);
        execution.onOutput?.("stderr", buffered);
      },
      onStdoutData: (chunk) => {
        const buffered = Buffer.from(chunk);
        stdout.push(buffered);
        execution.onOutput?.("stdout", buffered);
      },
      processGroupId: isWindows ? undefined : child.pid,
      verifyAfterMs: timeoutForceSettleMs,
    });
  });
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
