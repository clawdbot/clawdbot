// Qa Lab plugin module implements Mantis command-stage behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  addTimerTimeoutGraceMs,
  resolvePositiveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { readQaScenarioById } from "../scenario-catalog.js";
import { MANTIS_WORKTREE_CLEANUP_TIMEOUT_MS } from "./run-command.constants.js";

type MantisCommandStage = "worktree-add" | "install" | "build" | "qa" | "worktree-cleanup";
export type MantisCommandExecution = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stage: MantisCommandStage;
  timeoutMs: number;
};
export type MantisCommandResult = Awaited<ReturnType<typeof runCommandWithTimeout>>;
export type MantisCommandRunner = (
  command: string,
  args: readonly string[],
  execution: MantisCommandExecution,
) => Promise<MantisCommandResult>;
export type MantisCommandTimeoutOverrides = Partial<Record<MantisCommandStage, number>>;
export type MantisCommandTimeouts = Record<MantisCommandStage, number>;

const DEFAULT_WORKTREE_ADD_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60_000;
const QA_COMMAND_TIMEOUT_GRACE_MS = 5 * 60_000;

function resolveQaCommandTimeoutMs(scenarioId: string): number {
  const scenario = readQaScenarioById(scenarioId);
  const execution = scenario.execution;
  if (execution.kind !== "flow" || !execution.flow) {
    throw new Error(`Mantis scenario ${scenarioId} must be a flow QA scenario.`);
  }
  const timeoutMs = execution.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Mantis scenario ${scenarioId} must define a positive execution.timeoutMs.`);
  }
  const attemptCount = execution.retryCount === 0 ? 1 : 2;
  const attemptedTimeoutMs = timeoutMs * attemptCount;
  const timeoutWithGraceMs = addTimerTimeoutGraceMs(
    attemptedTimeoutMs,
    QA_COMMAND_TIMEOUT_GRACE_MS,
  );
  return resolvePositiveTimerTimeoutMs(timeoutWithGraceMs, timeoutMs);
}

export function resolveMantisCommandTimeouts(
  scenarioId: string,
  overrides: MantisCommandTimeoutOverrides | undefined,
): MantisCommandTimeouts {
  const defaults: MantisCommandTimeouts = {
    "worktree-add": DEFAULT_WORKTREE_ADD_TIMEOUT_MS,
    install: DEFAULT_INSTALL_TIMEOUT_MS,
    build: DEFAULT_BUILD_TIMEOUT_MS,
    qa: resolveQaCommandTimeoutMs(scenarioId),
    "worktree-cleanup": MANTIS_WORKTREE_CLEANUP_TIMEOUT_MS,
  };
  return {
    "worktree-add": resolvePositiveTimerTimeoutMs(
      overrides?.["worktree-add"],
      defaults["worktree-add"],
    ),
    install: resolvePositiveTimerTimeoutMs(overrides?.install, defaults.install),
    build: resolvePositiveTimerTimeoutMs(overrides?.build, defaults.build),
    qa: resolvePositiveTimerTimeoutMs(overrides?.qa, defaults.qa),
    "worktree-cleanup": resolvePositiveTimerTimeoutMs(
      overrides?.["worktree-cleanup"],
      defaults["worktree-cleanup"],
    ),
  };
}

function isWorktreeListCommand(command: string, args: readonly string[]): boolean {
  return (
    command === "git" &&
    (args.length === 3 || args.length === 4) &&
    args[0] === "worktree" &&
    args[1] === "list" &&
    args[2] === "--porcelain" &&
    (args.length === 3 || args[3] === "-z")
  );
}

export async function defaultMantisCommandRunner(
  command: string,
  args: readonly string[],
  execution: MantisCommandExecution,
): Promise<MantisCommandResult> {
  const capturesWorktreeList = isWorktreeListCommand(command, args);
  return await runCommandWithTimeout([command, ...args], {
    cwd: execution.cwd,
    env: execution.env,
    killProcessTree: true,
    outputCapture: capturesWorktreeList ? { stdout: "head", stderr: "tail" } : "discard",
    signal: execution.signal,
    timeoutMs: execution.timeoutMs,
    ...(capturesWorktreeList
      ? {}
      : {
          onOutputChunk(chunk, stream) {
            (stream === "stdout" ? process.stdout : process.stderr).write(chunk);
          },
        }),
  });
}

export function assertMantisCommandNotAborted(params: {
  args: readonly string[];
  command: string;
  execution: MantisCommandExecution;
  lane: "baseline" | "candidate";
}): void {
  if (!params.execution.signal?.aborted) {
    return;
  }
  const commandLabel = [params.command, ...params.args].join(" ");
  throw new Error(`${params.lane} ${params.execution.stage} aborted: ${commandLabel}`, {
    cause: params.execution.signal.reason,
  });
}

export async function runMantisCommand(params: {
  args: readonly string[];
  command: string;
  execution: MantisCommandExecution;
  lane: "baseline" | "candidate";
  runner: MantisCommandRunner;
}): Promise<MantisCommandResult> {
  assertMantisCommandNotAborted(params);
  const label = [params.command, ...params.args].join(" ");
  let result: MantisCommandResult;
  try {
    result = await params.runner(params.command, params.args, params.execution);
  } catch (error) {
    if (params.execution.signal?.aborted) {
      throw new Error(`${params.lane} ${params.execution.stage} aborted: ${label}`, {
        cause: error,
      });
    }
    throw new Error(
      `${params.lane} ${params.execution.stage} failed to run ${label}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
  if (result.termination === "timeout") {
    throw new Error(
      `${params.lane} ${params.execution.stage} timed out after ${params.execution.timeoutMs}ms: ${label}`,
    );
  }
  if (result.termination === "signal" && params.execution.signal?.aborted) {
    throw new Error(`${params.lane} ${params.execution.stage} aborted: ${label}`, {
      cause: params.execution.signal.reason,
    });
  }
  if (result.code === 0) {
    return result;
  }
  const detail = result.signal
    ? `signal ${result.signal}`
    : `exit code ${result.code ?? "unknown"}`;
  throw new Error(`${params.lane} ${params.execution.stage} failed with ${detail}: ${label}`);
}
