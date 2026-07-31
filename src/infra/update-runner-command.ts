import { runCommandWithTimeout } from "../process/exec.js";
import { trimLogTail } from "./restart-sentinel.js";
import { createGlobalInstallEnv } from "./update-global.js";
import type {
  CommandRunner,
  RunStepOptions,
  UpdateRunResult,
  UpdateStepInfo,
  UpdateStepResult,
} from "./update-runner-types.js";

export const DEFAULT_TIMEOUT_MS = 20 * 60_000;
export const MAX_LOG_CHARS = 8000;

function mergeCommandEnvironments(
  baseEnv: NodeJS.ProcessEnv | undefined,
  overrideEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (!baseEnv) {
    return overrideEnv;
  }
  if (!overrideEnv) {
    return baseEnv;
  }
  return { ...baseEnv, ...overrideEnv };
}

export async function runStep(opts: RunStepOptions): Promise<UpdateStepResult> {
  const { runCommand, name, argv, cwd, timeoutMs, env, progress, stepIndex, totalSteps } = opts;
  const command = argv.join(" ");
  const stepInfo: UpdateStepInfo = { name, command, index: stepIndex, total: totalSteps };
  progress?.onStepStart?.(stepInfo);

  const started = Date.now();
  const result = await runCommand(argv, { cwd, timeoutMs, env });
  const durationMs = Date.now() - started;
  const stderrTail = trimLogTail(result.stderr, MAX_LOG_CHARS);

  progress?.onStepComplete?.({
    ...stepInfo,
    durationMs,
    exitCode: result.code,
    stderrTail,
    signal: result.signal,
    killed: result.killed,
    termination: result.termination,
  });

  return {
    name,
    command,
    cwd,
    durationMs,
    exitCode: result.code,
    stdoutTail: trimLogTail(result.stdout, MAX_LOG_CHARS),
    stderrTail,
    signal: result.signal,
    killed: result.killed,
    termination: result.termination,
  };
}

export function normalizeFallbackFailureReason(
  stepName: string,
): NonNullable<UpdateRunResult["reason"]> {
  switch (stepName) {
    case "global update":
    case "global update (omit optional)":
    case "global install stage":
    case "global install verify":
    case "global install swap":
      return "global-install-failed";
    case "openclaw doctor":
      return "doctor-failed";
    case "ui:build (post-doctor repair)":
      return "ui-build-failed";
    default:
      return "unexpected-error";
  }
}

export async function buildUpdateCommandRunner(
  runCommand?: CommandRunner,
): Promise<{ defaultCommandEnv: NodeJS.ProcessEnv | undefined; runCommand: CommandRunner }> {
  const defaultCommandEnv = await createGlobalInstallEnv();
  if (runCommand) {
    return { defaultCommandEnv, runCommand };
  }
  return {
    defaultCommandEnv,
    runCommand: async (argv, options) =>
      await runCommandWithTimeout(argv, {
        ...options,
        env: mergeCommandEnvironments(defaultCommandEnv, options.env),
        // Package-manager trees must not outlive a timed-out updater.
        killProcessTree: true,
      }),
  };
}
