import { defaultRuntime } from "../runtime.js";
import { formatCliJsonFailure } from "./failure-output.js";
import { exitCliAfterOutput } from "./one-shot-exit.js";

/** Keep each secrets command's payload, failure envelope, and exit code in one path. */
export async function runSecretsCommand<T>(
  json: boolean | undefined,
  run: () => Promise<T>,
  renderHumanFailure: (error: unknown) => void,
  failureExit: number | ((error: unknown) => { error: unknown; exitCode: number }),
  jsonResult?: (result: T) => unknown,
): Promise<T> {
  try {
    const result = await run();
    if (json) {
      defaultRuntime.writeJson(jsonResult ? jsonResult(result) : result);
    }
    return result;
  } catch (error) {
    const failure =
      typeof failureExit === "function" ? failureExit(error) : { error, exitCode: failureExit };
    if (json) {
      defaultRuntime.writeJson(formatCliJsonFailure(failure.error));
    } else {
      renderHumanFailure(failure.error);
    }
    return exitCliAfterOutput(defaultRuntime, failure.exitCode);
  }
}
