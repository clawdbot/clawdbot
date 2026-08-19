// Top-level cron CLI registration and subcommand wiring.
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { inheritOptionFromParent } from "../command-options.js";
import { addGatewayClientOptions } from "../gateway-rpc.js";
import { setCommandJsonMode } from "../program/json-mode.js";
import { applyParentDefaultHelpAction } from "../program/parent-default-help.js";
import { isCronMachineOutput } from "./output-mode.js";
import {
  registerCronAddCommand,
  registerCronListCommand,
  registerCronStatusCommand,
} from "./register.cron-add.js";
import { registerCronEditCommand } from "./register.cron-edit.js";
import { registerCronScratchCommand } from "./register.cron-scratch.js";
import { registerCronSimpleCommands } from "./register.cron-simple.js";

const CRON_GATEWAY_OPTION_NAMES = [
  "url",
  "port",
  "token",
  "password",
  "timeout",
  "expectFinal",
] as const;

function inheritCronGatewayOptions(command: Command): void {
  for (const name of CRON_GATEWAY_OPTION_NAMES) {
    const inherited = inheritOptionFromParent(command, name);
    const source = command.parent?.getOptionValueSource(name);
    if (inherited !== undefined && source && source !== "default") {
      command.setOptionValueWithSource(name, inherited, source);
    }
  }
}

export function registerCronCli(program: Command) {
  const cron = program
    .command("cron")
    .alias("automations")
    .description("Manage automations (via Gateway)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/cron", "docs.openclaw.ai/cli/cron")}\n${theme.muted("Upgrade tip:")} run \`openclaw doctor --fix\` to normalize legacy automation storage.\n`,
    );

  addGatewayClientOptions(cron);
  cron.hook("preAction", (_parent, command) => inheritCronGatewayOptions(command));

  registerCronStatusCommand(cron);
  registerCronListCommand(cron);
  registerCronAddCommand(cron);
  registerCronSimpleCommands(cron);
  registerCronScratchCommand(cron);
  registerCronEditCommand(cron);
  setCommandJsonMode(cron, "output", ({ argv }) => isCronMachineOutput(argv));

  applyParentDefaultHelpAction(cron);
}
