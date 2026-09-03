import type { Command } from "commander";

export const COLD_READ_COMMAND_PATHS: string[][] = [
  ["audit"],
  ["node", "identity"],
  ["skills", "info"],
  ["skills", "search"],
  ["hooks"],
  ["hooks", "list"],
  ["hooks", "info"],
  ["hooks", "check"],
  ["update", "--dry-run"],
];

export function registerColdReadCommandFixtures(program: Command, skills: Command): void {
  program
    .command("node")
    .command("identity")
    .option("--json")
    .action(() => {});
  program
    .command("audit")
    .option("--json")
    .action(() => {});
  for (const skillCommand of ["info", "search"]) {
    skills
      .command(skillCommand)
      .argument("[value]")
      .option("--json")
      .action(() => {});
  }
  const hooks = program
    .command("hooks")
    .option("--json")
    .action(() => {});
  hooks
    .command("list")
    .option("--json")
    .action(() => {});
  hooks
    .command("info")
    .argument("[name]")
    .option("--json")
    .action(() => {});
  hooks
    .command("check")
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
