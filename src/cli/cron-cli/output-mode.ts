import type { Command } from "commander";
import {
  getMachineOutputCommandPath,
  hasMachineOutputOption,
  MACHINE_OUTPUT_JSON_OPTION_DESCRIPTION,
} from "../machine-output-argv.js";

type CronOutputCommandDefinition = {
  aliases: readonly string[];
  alwaysJson: boolean;
};

const CRON_OUTPUT_COMMANDS = {
  status: { aliases: [], alwaysJson: true },
  add: { aliases: ["create"], alwaysJson: true },
  rm: { aliases: ["remove", "delete"], alwaysJson: true },
  enable: { aliases: [], alwaysJson: true },
  disable: { aliases: [], alwaysJson: true },
  get: { aliases: [], alwaysJson: true },
  runs: { aliases: [], alwaysJson: true },
  run: { aliases: [], alwaysJson: true },
  edit: { aliases: [], alwaysJson: true },
  scratch: { aliases: [], alwaysJson: false },
} as const satisfies Record<string, CronOutputCommandDefinition>;

type CronOutputCommandName = keyof typeof CRON_OUTPUT_COMMANDS;
const MACHINE_OUTPUT_COMMANDS = new Map(
  Object.entries(CRON_OUTPUT_COMMANDS).flatMap(([name, definition]) =>
    [name, ...definition.aliases].map((alias) => [alias, definition.alwaysJson] as const),
  ),
);

export function createCronOutputCommand(parent: Command, name: CronOutputCommandName): Command {
  const definition = CRON_OUTPUT_COMMANDS[name];
  const command = parent.command(name);
  for (const alias of definition.aliases) {
    command.alias(alias);
  }
  return definition.alwaysJson
    ? command.option("--json", MACHINE_OUTPUT_JSON_OPTION_DESCRIPTION)
    : command.option("--json", "Output JSON", false);
}

export function isCronMachineOutput(argv: readonly string[]): boolean {
  const [, command] = getMachineOutputCommandPath(argv, 2);
  if (!command) {
    return false;
  }
  const alwaysJson = MACHINE_OUTPUT_COMMANDS.get(command);
  if (alwaysJson === undefined) {
    return false;
  }
  return (
    alwaysJson || !["--set", "--file", "--unset"].some((flag) => hasMachineOutputOption(argv, flag))
  );
}
