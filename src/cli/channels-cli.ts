import type { Command } from "commander";
import { listChatChannels } from "../channels/registry.js";
import {
  channelsAddCommand,
  channelsListCommand,
  channelsLogsCommand,
  channelsRemoveCommand,
  channelsStatusCommand,
} from "../commands/channels.js";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runChannelLogin, runChannelLogout } from "./channel-auth.js";
import { hasExplicitOptions } from "./command-options.js";

const optionNamesAdd = [
  "channel",
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

const optionNamesRemove = ["channel", "account", "delete"] as const;

const channelNames = listChatChannels()
  .map((meta) => meta.id)
  .join("|");

export function registerChannelsCli(program: Command) {
  const channels = program
    .command("channels")
    .description("Manage chat channel accounts")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink(
          "/configuration",
          "docs.clawd.bot/configuration",
        )}\n`,
    );

  channels
    .command("list")
    .description("List configured channels + auth profiles")
    .option("--no-usage", "Skip model provider usage/quota snapshots")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      try {
        await channelsListCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  channels
    .command("status")
    .description("Show gateway channel status (use status --deep for local)")
    .option("--probe", "Probe channel credentials", false)
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      try {
        await channelsStatusCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  channels
    .command("logs")
    .description("Show recent channel logs from the gateway log file")
    .option("--channel <name>", `Channel (${channelNames}|all)`, "all")
    .option("--lines <n>", "Number of lines (default: 200)", "200")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      try {
        await channelsLogsCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  channels
    .command("add")
    .description("Add or update a channel account")
    .option("--channel <name>", `Channel (${channelNames})`)
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
        await channelsAddCommand(opts, defaultRuntime, { hasFlags });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  channels
    .command("remove")
    .description("Disable or delete a channel account")
    .option("--channel <name>", `Channel (${channelNames})`)
    .option("--account <id>", "Account id (default when omitted)")
    .option("--delete", "Delete config entries (no prompt)", false)
    .action(async (opts, command) => {
      try {
        const hasFlags = hasExplicitOptions(command, optionNamesRemove);
        await channelsRemoveCommand(opts, defaultRuntime, { hasFlags });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  channels
    .command("login")
    .description("Link a channel account (WhatsApp Web only)")
    .option("--channel <channel>", "Channel alias (default: whatsapp)")
    .option("--account <id>", "WhatsApp account id (accountId)")
    .option("--verbose", "Verbose connection logs", false)
    .action(async (opts) => {
      try {
        await runChannelLogin(
          {
            channel: opts.channel as string | undefined,
            account: opts.account as string | undefined,
            verbose: Boolean(opts.verbose),
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(danger(`Channel login failed: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });

  channels
    .command("logout")
    .description("Log out of a channel session (if supported)")
    .option("--channel <channel>", "Channel alias (default: whatsapp)")
    .option("--account <id>", "Account id (accountId)")
    .action(async (opts) => {
      try {
        await runChannelLogout(
          {
            channel: opts.channel as string | undefined,
            account: opts.account as string | undefined,
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(danger(`Channel logout failed: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });
}
