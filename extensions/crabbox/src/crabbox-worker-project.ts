import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";
import { runCrabboxCommand, type CrabboxCommandRunner } from "./crabbox-worker-command.js";

type ProjectPreparation = NonNullable<
  NonNullable<Parameters<WorkerProvider["provision"]>[2]>["project"]
>;

/** Core owns Git contents; this adapter owns only the existing lease's transport. */
export async function prepareCrabboxProjectFiles(params: {
  project: ProjectPreparation;
  binary: string;
  provider: string;
  id: string;
  runArgs: string[];
  runCommand: CrabboxCommandRunner;
  timeoutMs: () => number;
}): Promise<void> {
  const run = async (args: string[], signal: AbortSignal, input?: string) => {
    params.project.assertCurrent();
    const result = await runCrabboxCommand({
      action: "project preparation",
      args,
      binary: params.binary,
      runCommand: params.runCommand,
      signal,
      input,
      timeoutMs: params.timeoutMs(),
    });
    params.project.assertCurrent();
    if (result.termination !== "exit" || result.code !== 0) {
      throw crabboxCommandError("project preparation", result);
    }
    return result.stdout;
  };
  await params.project.prepare({
    runScript: (input, signal) => run(params.runArgs, signal, input),
    upload: async (localPath, remotePath, signal) => {
      await run(
        [
          "cp",
          "--provider",
          params.provider,
          "--id",
          params.id,
          localPath,
          `SANDBOX:${remotePath}`,
        ],
        signal,
      );
    },
  });
}
