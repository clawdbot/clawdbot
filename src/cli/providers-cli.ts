import type { Command } from "commander";

import {
  providersAddCommand,
  providersListCommand,
  providersLogsCommand,
  providersRemoveCommand,
  providersStatusCommand,
} from "../commands/providers.js";
import { danger } from "../globals.js";
import { listChatProviders } from "../providers/registry.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { hasExplicitOptions } from "./command-options.js";
import { runProviderLogin, runProviderLogout } from "./provider-auth.js";

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

const providerNames = listChatProviders()
  .map((meta) => meta.id)
  .join("|");

export function registerProvidersCli(program: Command) {
  const providers = program
    .command("providers")
    .alias("provider")
    .description("Manage chat provider accounts")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink(
          "/configuration",
          "docs.clawd.bot/configuration",
        )}\n`,
    );

  providers
    .command("list")
    .description("List configured providers + auth profiles")
    .option("--no-usage", "Skip provider usage/quota snapshots")
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
    .description("Show gateway provider status (use status --deep for local)")
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
    .command("logs")
    .description("Show recent provider logs from the gateway log file")
    .option("--provider <name>", `Provider (${providerNames}|all)`, "all")
    .option("--lines <n>", "Number of lines (default: 200)", "200")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      try {
        await providersLogsCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  providers
    .command("add")
    .description("Add or update a provider account")
    .option("--provider <name>", `Provider (${providerNames})`)
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
    .option("--provider <name>", `Provider (${providerNames})`)
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

  providers
    .command("login")
    .description("Link a provider account (WhatsApp Web only)")
    .option("--provider <provider>", "Provider alias (default: whatsapp)")
    .option("--account <id>", "WhatsApp account id (accountId)")
    .option("--verbose", "Verbose connection logs", false)
    .action(async (opts) => {
      try {
        await runProviderLogin(
          {
            provider: opts.provider as string | undefined,
            account: opts.account as string | undefined,
            verbose: Boolean(opts.verbose),
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(danger(`Provider login failed: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });

  providers
    .command("logout")
    .description("Log out of a provider session (if supported)")
    .option("--provider <provider>", "Provider alias (default: whatsapp)")
    .option("--account <id>", "Account id (accountId)")
    .action(async (opts) => {
      try {
        await runProviderLogout(
          {
            provider: opts.provider as string | undefined,
            account: opts.account as string | undefined,
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(danger(`Provider logout failed: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });
}
