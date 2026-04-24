import type { Command } from "commander";
import { danger } from "../globals.js";
import { listBundledPackageChannelMetadata } from "../plugins/bundled-package-channel-metadata.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runChannelLogin, runChannelLogout } from "./channel-auth.js";
import { formatCliChannelOptions } from "./channel-options.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { hasExplicitOptions } from "./command-options.js";
import { formatHelpExamples } from "./help-format.js";

type ChannelsCommandsModule = typeof import("../commands/channels.js");

const optionNamesRemove = ["channel", "account", "delete"] as const;

let channelsCommandsPromise: Promise<ChannelsCommandsModule> | undefined;

function loadChannelsCommands(): Promise<ChannelsCommandsModule> {
  channelsCommandsPromise ??= import("../commands/channels.js");
  return channelsCommandsPromise;
}

function runChannelsCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action);
}

function runChannelsCommandWithDanger(action: () => Promise<void>, label: string) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    defaultRuntime.error(danger(`${label}: ${String(err)}`));
    defaultRuntime.exit(1);
  });
}

function getOptionNames(command: Command): string[] {
  return command.options.map((option) => option.attributeName());
}

function addChannelSetupOptions(command: Command): Command {
  const seenFlags = new Set(command.options.map((option) => option.flags));
  const channels = listBundledPackageChannelMetadata().toSorted((left, right) => {
    const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER;
    return leftOrder === rightOrder
      ? (left.id ?? "").localeCompare(right.id ?? "")
      : leftOrder - rightOrder;
  });
  for (const channel of channels) {
    for (const option of channel.cliAddOptions ?? []) {
      if (seenFlags.has(option.flags)) {
        continue;
      }
      seenFlags.add(option.flags);
      if (option.defaultValue !== undefined) {
        command.option(option.flags, option.description, option.defaultValue);
      } else {
        command.option(option.flags, option.description);
      }
    }
  }
  return command;
}

export function registerChannelsCli(program: Command) {
  const channelNames = formatCliChannelOptions();
  const channels = program
    .command("channels")
    .description("Manage connected chat channels and accounts")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw channels list", "List configured channels and auth profiles."],
          ["openclaw channels status --probe", "Run channel status checks and probes."],
          [
            "openclaw channels add --channel telegram --token <token>",
            "Add or update a channel account non-interactively.",
          ],
          ["openclaw channels login --channel whatsapp", "Link a WhatsApp Web account."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink(
          "/cli/channels",
          "docs.openclaw.ai/cli/channels",
        )}\n`,
    );

  channels
    .command("list")
    .description("List configured channels + auth profiles")
    .option("--no-usage", "Skip model provider usage/quota snapshots")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runChannelsCommand(async () => {
        const { channelsListCommand } = await import("../commands/channels/list.js");
        await channelsListCommand(opts, defaultRuntime);
      });
    });

  channels
    .command("status")
    .description("Show gateway channel status (use status --deep for local)")
    .option("--probe", "Probe channel credentials", false)
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runChannelsCommand(async () => {
        const { channelsStatusCommand } = await import("../commands/channels/status.js");
        await channelsStatusCommand(opts, defaultRuntime);
      });
    });

  channels
    .command("capabilities")
    .description("Show provider capabilities (intents/scopes + supported features)")
    .option("--channel <name>", `Channel (${formatCliChannelOptions(["all"])})`)
    .option("--account <id>", "Account id (only with --channel)")
    .option("--target <dest>", "Channel target for permission audit (Discord channel:<id>)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runChannelsCommand(async () => {
        const { channelsCapabilitiesCommand } = await loadChannelsCommands();
        await channelsCapabilitiesCommand(opts, defaultRuntime);
      });
    });

  channels
    .command("resolve")
    .description("Resolve channel/user names to IDs")
    .argument("<entries...>", "Entries to resolve (names or ids)")
    .option("--channel <name>", `Channel (${channelNames})`)
    .option("--account <id>", "Account id (accountId)")
    .option("--kind <kind>", "Target kind (auto|user|group)", "auto")
    .option("--json", "Output JSON", false)
    .action(async (entries, opts) => {
      await runChannelsCommand(async () => {
        const { channelsResolveCommand } = await loadChannelsCommands();
        await channelsResolveCommand(
          {
            channel: opts.channel as string | undefined,
            account: opts.account as string | undefined,
            kind: opts.kind as "auto" | "user" | "group",
            json: Boolean(opts.json),
            entries: Array.isArray(entries) ? entries : [String(entries)],
          },
          defaultRuntime,
        );
      });
    });

  channels
    .command("logs")
    .description("Show recent channel logs from the gateway log file")
    .option("--channel <name>", `Channel (${formatCliChannelOptions(["all"])})`, "all")
    .option("--lines <n>", "Number of lines (default: 200)", "200")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runChannelsCommand(async () => {
        const { channelsLogsCommand } = await loadChannelsCommands();
        await channelsLogsCommand(opts, defaultRuntime);
      });
    });

  addChannelSetupOptions(
    channels
      .command("add")
      .description("Add or update a channel account")
      .option("--channel <name>", `Channel (${channelNames})`)
      .option("--account <id>", "Account id (default when omitted)")
      .option("--name <name>", "Display name for this account")
      .option("--token <token>", "Channel token or credential payload")
      .option("--token-file <path>", "Read channel token or credential payload from file")
      .option("--secret <secret>", "Channel shared secret")
      .option("--secret-file <path>", "Read channel shared secret from file")
      .option("--bot-token <token>", "Bot token")
      .option("--app-token <token>", "App token")
      .option("--password <password>", "Channel password or login secret")
      .option("--cli-path <path>", "Channel CLI path")
      .option("--url <url>", "Channel setup URL")
      .option("--base-url <url>", "Channel base URL")
      .option("--http-url <url>", "Channel HTTP service URL")
      .option("--auth-dir <path>", "Channel auth directory override")
      .option("--use-env", "Use env-backed credentials when supported", false),
  ).action(async (opts, command) => {
    await runChannelsCommand(async () => {
      const { channelsAddCommand } = await loadChannelsCommands();
      const hasFlags = hasExplicitOptions(command, getOptionNames(command));
      await channelsAddCommand(opts, defaultRuntime, { hasFlags });
    });
  });

  channels
    .command("remove")
    .description("Disable or delete a channel account")
    .option("--channel <name>", `Channel (${channelNames})`)
    .option("--account <id>", "Account id (default when omitted)")
    .option("--delete", "Delete config entries (no prompt)", false)
    .action(async (opts, command) => {
      await runChannelsCommand(async () => {
        const { channelsRemoveCommand } = await loadChannelsCommands();
        const hasFlags = hasExplicitOptions(command, optionNamesRemove);
        await channelsRemoveCommand(opts, defaultRuntime, { hasFlags });
      });
    });

  channels
    .command("login")
    .description("Link a channel account (if supported)")
    .option("--channel <channel>", "Channel alias (auto when only one is configured)")
    .option("--account <id>", "Account id (accountId)")
    .option("--verbose", "Verbose connection logs", false)
    .action(async (opts) => {
      await runChannelsCommandWithDanger(async () => {
        await runChannelLogin(
          {
            channel: opts.channel as string | undefined,
            account: opts.account as string | undefined,
            verbose: Boolean(opts.verbose),
          },
          defaultRuntime,
        );
      }, "Channel login failed");
    });

  channels
    .command("logout")
    .description("Log out of a channel session (if supported)")
    .option("--channel <channel>", "Channel alias (auto when only one is configured)")
    .option("--account <id>", "Account id (accountId)")
    .action(async (opts) => {
      await runChannelsCommandWithDanger(async () => {
        await runChannelLogout(
          {
            channel: opts.channel as string | undefined,
            account: opts.account as string | undefined,
          },
          defaultRuntime,
        );
      }, "Channel logout failed");
    });
}
