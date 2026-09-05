import { expectDefined } from "@openclaw/normalization-core";
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
  ["models", "accounts", "list"],
  ["models", "accounts", "login", "openai"],
  ["models", "accounts", "use", "personal-account"],
  ["models", "accounts", "clear-default", "openai"],
];

export function registerColdReadCommandFixtures(program: Command, skills: Command): void {
  const models = expectDefined(
    program.commands.find((command) => command.name() === "models"),
    "Expected the models fixture",
  );
  const accounts = models.command("accounts");
  for (const command of ["list", "login", "use", "clear-default"]) {
    accounts
      .command(command)
      .argument("[value]")
      .option("--json")
      .action(() => {});
  }
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
