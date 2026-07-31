import { formatErrorMessage } from "../infra/errors.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";
import { isTerminalInteractive } from "./terminal-interactivity.js";

type InvalidConfigRecoveryResult<T> =
  | { status: "declined" }
  | { status: "recovered"; value: T }
  | { status: "retry-failed" };

export type InvalidConfigRecoveryDeps = {
  confirm?: (question: string, defaultYes: boolean) => Promise<boolean>;
  isInteractive?: () => boolean;
  runDoctor?: (runtime: RuntimeEnv) => Promise<void>;
};

/** Offer a consent-gated doctor repair, then retry the failed operation once. */
export async function offerInvalidConfigRecovery<T>(params: {
  runtime: RuntimeEnv;
  retry: () => Promise<T>;
  deps?: InvalidConfigRecoveryDeps;
}): Promise<InvalidConfigRecoveryResult<T>> {
  const command = formatCliCommand("openclaw doctor --fix");
  const printCommand = () => {
    params.runtime.error(`Run "${command}" to repair the config, then retry.`);
  };
  const isInteractive = params.deps?.isInteractive ?? isTerminalInteractive;
  if (!isInteractive()) {
    printCommand();
    return { status: "declined" };
  }

  const confirm =
    params.deps?.confirm ??
    (async (question: string, defaultYes: boolean) => {
      const { promptYesNo } = await import("./prompt.js");
      return await promptYesNo(question, defaultYes);
    });
  if (!(await confirm(`Run "${command}" now?`, true))) {
    printCommand();
    return { status: "declined" };
  }

  const runDoctor =
    params.deps?.runDoctor ??
    (async (runtime: RuntimeEnv) => {
      const { doctorCommand } = await import("../commands/doctor.js");
      await doctorCommand(runtime, { repair: true });
    });
  try {
    await runDoctor(params.runtime);
  } catch (error) {
    if (error instanceof ExitError) {
      throw error;
    }
    params.runtime.error(`Failed to run "${command}": ${formatErrorMessage(error)}`);
    return { status: "retry-failed" };
  }

  try {
    return { status: "recovered", value: await params.retry() };
  } catch (error) {
    const { isInvalidConfigError } = await import("../config/io.invalid-config.js");
    if (!isInvalidConfigError(error)) {
      throw error;
    }
    params.runtime.error(`Config is still invalid after "${command}":`);
    params.runtime.error(formatErrorMessage(error));
    return { status: "retry-failed" };
  }
}
