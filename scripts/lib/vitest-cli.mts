import { waitForever } from "../../src/cli/wait.ts";
import { runWithFailedTrailer, writeFailedTrailer } from "./failed-trailer.mts";
import { signalExitCode } from "./managed-child-process.mts";

export async function exitVitestBySignal(signal: NodeJS.Signals): Promise<void> {
  process.kill(process.pid, signal);
  // Dependency signal handlers may finish cleanup and re-raise asynchronously.
  // A numeric return must not win that race.
  await waitForever();
}

/** Only public invocations report; internal children propagate their settled outcome. */
export function runVitestCli(
  tool: string,
  run: (exitBySignal: typeof exitVitestBySignal) => Promise<void>,
): Promise<void> {
  return runWithFailedTrailer(tool, () =>
    run(async (signal) => {
      writeFailedTrailer(tool, signalExitCode(signal));
      await exitVitestBySignal(signal);
    }),
  );
}
