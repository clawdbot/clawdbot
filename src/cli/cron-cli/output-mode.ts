import type { Command } from "commander";
import { getCommandPositionalsWithRootOptions } from "../../infra/cli-root-options.js";
import {
  getMachineOutputCommandPath,
  MACHINE_OUTPUT_JSON_OPTION_DESCRIPTION,
} from "../machine-output-argv.js";

export const CRON_GATEWAY_OPTION_NAMES = [
  "url",
  "port",
  "token",
  "password",
  "timeout",
  "expectFinal",
] as const;

const CRON_GATEWAY_VALUE_FLAGS = CRON_GATEWAY_OPTION_NAMES.filter(
  (name) => name !== "expectFinal",
).map((name) => `--${name}`);

const CRON_SCRATCH_JSON_OPTION_DESCRIPTION =
  "Output scratch plus revision metadata as JSON; writes return JSON by default";

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
const MACHINE_OUTPUT_COMMANDS = new Set<string>();
for (const [name, definition] of Object.entries(CRON_OUTPUT_COMMANDS)) {
  MACHINE_OUTPUT_COMMANDS.add(name);
  for (const alias of definition.aliases) {
    MACHINE_OUTPUT_COMMANDS.add(alias);
  }
}

export function createCronOutputCommand(parent: Command, name: CronOutputCommandName): Command {
  const definition = CRON_OUTPUT_COMMANDS[name];
  const command = parent.command(name);
  for (const alias of definition.aliases) {
    command.alias(alias);
  }
  return definition.alwaysJson
    ? command.option("--json", MACHINE_OUTPUT_JSON_OPTION_DESCRIPTION)
    : command.option("--json", CRON_SCRATCH_JSON_OPTION_DESCRIPTION);
}

export function isCronMachineOutput(argv: readonly string[]): boolean {
  const [root] = getMachineOutputCommandPath(argv, 1);
  if (!root) {
    return false;
  }
  const [command] =
    getCommandPositionalsWithRootOptions(argv, {
      commandPath: [root],
      booleanFlags: ["--expect-final"],
      valueFlags: CRON_GATEWAY_VALUE_FLAGS,
      maxPositionals: 1,
    }) ?? [];
  return command !== undefined && MACHINE_OUTPUT_COMMANDS.has(command);
}
