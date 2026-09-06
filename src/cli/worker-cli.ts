import { Option, type Command } from "commander";

/** Register the restricted cloud worker runtime entry point. */
export function registerWorkerCli(program: Command): void {
  program
    .command("worker")
    .description("Run the restricted cloud worker runtime")
    .addOption(new Option("--internal-worker-ipc").hideHelp())
    .action(async (options: { internalWorkerIpc?: boolean }) => {
      const { runWorkerProcess } = await import("../worker/worker-process.js");
      await runWorkerProcess({ internalWorkerIpc: options.internalWorkerIpc === true });
    });
}
