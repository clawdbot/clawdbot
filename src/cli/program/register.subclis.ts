import type { Command } from "commander";
import { loadConfig } from "../../config/config.js";
import { registerPluginCliCommands } from "../../plugins/cli.js";
import { registerAcpCli } from "../acp-cli.js";
import { registerChannelsCli } from "../channels-cli.js";
import { registerCronCli } from "../cron-cli.js";
import { registerDaemonCli } from "../daemon-cli.js";
import { registerDnsCli } from "../dns-cli.js";
import { registerDirectoryCli } from "../directory-cli.js";
import { registerDocsCli } from "../docs-cli.js";
import { registerExecApprovalsCli } from "../exec-approvals-cli.js";
import { registerGatewayCli } from "../gateway-cli.js";
import { registerHooksCli } from "../hooks-cli.js";
import { registerWebhooksCli } from "../webhooks-cli.js";
import { registerLogsCli } from "../logs-cli.js";
import { registerModelsCli } from "../models-cli.js";
import { registerNodesCli } from "../nodes-cli.js";
import { registerNodeCli } from "../node-cli.js";
import { registerPairingCli } from "../pairing-cli.js";
import { registerPluginsCli } from "../plugins-cli.js";
import { registerSandboxCli } from "../sandbox-cli.js";
import { registerSecurityCli } from "../security-cli.js";
import { registerServiceCli } from "../service-cli.js";
import { registerSkillsCli } from "../skills-cli.js";
import { registerTuiCli } from "../tui-cli.js";
import { registerUpdateCli } from "../update-cli.js";

const ALL_SUBCOMMANDS = [
  { name: "acp", register: registerAcpCli },
  { name: "daemon", register: registerDaemonCli },
  { name: "gateway", register: registerGatewayCli },
  { name: "service", register: registerServiceCli },
  { name: "logs", register: registerLogsCli },
  { name: "models", register: registerModelsCli },
  { name: "exec-approvals", register: registerExecApprovalsCli },
  { name: "nodes", register: registerNodesCli },
  { name: "node", register: registerNodeCli },
  { name: "sandbox", register: registerSandboxCli },
  { name: "tui", register: registerTuiCli },
  { name: "cron", register: registerCronCli },
  { name: "dns", register: registerDnsCli },
  { name: "docs", register: registerDocsCli },
  { name: "hooks", register: registerHooksCli },
  { name: "webhooks", register: registerWebhooksCli },
  { name: "pairing", register: registerPairingCli },
  { name: "plugins", register: registerPluginsCli },
  { name: "channels", register: registerChannelsCli },
  { name: "directory", register: registerDirectoryCli },
  { name: "security", register: registerSecurityCli },
  { name: "skills", register: registerSkillsCli },
  { name: "update", register: registerUpdateCli },
];

export function registerSubCliCommands(program: Command, argv?: string[]) {
  // If argv is not provided, do eager loading (normal CLI usage)
  if (!argv) {
    // Register all commands eagerly
    for (const cmd of ALL_SUBCOMMANDS) {
      cmd.register(program);
    }
    registerPluginCliCommands(program, loadConfig());
    return;
  }

  // Get the primary command from argv (element at index 2, after "node" and "clawdbot")
  const primaryCommand = argv[2];

  if (primaryCommand && ALL_SUBCOMMANDS.some((cmd) => cmd.name === primaryCommand)) {
    // If there's a specific primary command in argv, register only that one and dispatch
    const cmd = ALL_SUBCOMMANDS.find((c) => c.name === primaryCommand);
    if (cmd) {
      cmd.register(program);
    }
  } else {
    // Otherwise, register placeholders for all subcommands (lazy loading)
    for (const cmd of ALL_SUBCOMMANDS) {
      program
        .command(cmd.name)
        .description(`Placeholder for ${cmd.name}`)
        .action(() => {
          cmd.register(program);
        });
    }

    // Also handle plugin CLI commands
    registerPluginCliCommands(program, loadConfig());
  }
}
