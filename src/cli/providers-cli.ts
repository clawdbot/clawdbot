import type { Command } from "commander";

import {
  providersAddCommand,
  providersListCommand,
  providersRemoveCommand,
  providersStatusCommand,
} from "../commands/providers.js";
import { defaultRuntime } from "../runtime.js";

const optionNamesAdd = [
  "provider",
  "account",
  "name",
  "token",
  "tokenFile",
  "botToken",
  "appToken",
  "signalNumber",
  "cliPath",
  "dbPath",
  "service",
  "region",
  "authDir",
  "httpUrl",
  "httpHost",
  "httpPort",
  "useEnv",
] as const;

const optionNamesRemove = ["provider", "account", "delete"] as const;

function hasExplicitOptions(
  command: Command,
  names: readonly string[],
): boolean {
  return names.some((name) => {
    if (typeof command.getOptionValueSource !== "function") {
      return false;
    }
    return command.getOptionValueSource(name) === "cli";
  });
}

export function registerProvidersCli(program: Command) {
  const providers = program
    .command("providers")
    .alias("provider")
    .description("Manage chat provider accounts");

  providers
    .command("list")
    .description("List configured providers + auth profiles")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      try {
        await providersListCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  providers
    .command("status")
    .description("Show gateway provider status")
    .option("--probe", "Probe provider credentials", false)
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      try {
        await providersStatusCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  providers
    .command("add")
    .description("Add or update a provider account")
    .option(
      "--provider <name>",
      "Provider (whatsapp|telegram|discord|slack|signal|imessage)",
    )
    .option("--account <id>", "Account id (default when omitted)")
    .option("--name <name>", "Display name for this account")
    .option("--token <token>", "Bot token (Telegram/Discord)")
    .option("--token-file <path>", "Bot token file (Telegram)")
    .option("--bot-token <token>", "Slack bot token (xoxb-...)")
    .option("--app-token <token>", "Slack app token (xapp-...)")
    .option("--signal-number <e164>", "Signal account number (E.164)")
    .option("--cli-path <path>", "CLI path (signal-cli or imsg)")
    .option("--db-path <path>", "iMessage database path")
    .option("--service <service>", "iMessage service (imessage|sms|auto)")
    .option("--region <region>", "iMessage region (for SMS)")
    .option("--auth-dir <path>", "WhatsApp auth directory override")
    .option("--http-url <url>", "Signal HTTP daemon base URL")
    .option("--http-host <host>", "Signal HTTP host")
    .option("--http-port <port>", "Signal HTTP port")
    .option("--use-env", "Use env token (default account only)", false)
    .action(async (opts, command) => {
      try {
        const hasFlags = hasExplicitOptions(command, optionNamesAdd);
        await providersAddCommand(opts, defaultRuntime, { hasFlags });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  providers
    .command("remove")
    .description("Disable or delete a provider account")
    .option(
      "--provider <name>",
      "Provider (whatsapp|telegram|discord|slack|signal|imessage)",
    )
    .option("--account <id>", "Account id (default when omitted)")
    .option("--delete", "Delete config entries (no prompt)", false)
    .action(async (opts, command) => {
      try {
        const hasFlags = hasExplicitOptions(command, optionNamesRemove);
        await providersRemoveCommand(opts, defaultRuntime, { hasFlags });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
