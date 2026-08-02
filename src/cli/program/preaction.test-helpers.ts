import type { Command } from "commander";

export const COLD_READ_COMMAND_PATHS: string[][] = [
  ["skills", "info"],
  ["skills", "search"],
  ["hooks"],
  ["memory", "status"],
  ["memory", "search"],
];

export function registerColdReadCommandFixtures(program: Command, skills: Command): void {
  for (const skillCommand of ["info", "search"]) {
    skills
      .command(skillCommand)
      .argument("[value]")
      .option("--json")
      .action(() => {});
  }
  program
    .command("hooks")
    .option("--json")
    .action(() => {});
  const memory = program.command("memory");
  memory
    .command("status")
    .option("--agent <id>")
    .option("--index")
    .option("--fix")
    .option("--json")
    .action(() => {});
  memory
    .command("search")
    .argument("[query]")
    .option("--agent <id>")
    .option("--json")
    .action(() => {});
}
