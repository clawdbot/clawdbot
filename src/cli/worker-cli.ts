import type { Command } from "commander";

/** Register the restricted cloud worker runtime entry point. */
export function registerWorkerCli(program: Command): void {
  program
    .command("worker")
    .description("Run the restricted cloud worker runtime")
    .action(async () => {
      const { runWorkerCommand } = await import("../worker/worker-command.runtime.js");
      await runWorkerCommand({
        input: process.stdin,
        output: process.stdout,
      });
    });
}
