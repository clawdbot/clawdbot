// Commander registration for channel discovery, setup, status, auth, and diagnostics commands.
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { runChannelLogin, runChannelLogout } from "./channel-auth.js";
import { formatCliChannelOptions } from "./channel-options.js";
import {
  getChannelSetupOptionSwitches,
  loadChannelSetupCliOptions,
  resolveChannelsAddChannelFromArgv,
  resolveChannelsAddOptions,
  type ChannelSetupCliOption,
} from "./channels-cli-add-args.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { hasExplicitOptions } from "./command-options.js";
import { formatHelpExamples } from "./help-format.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

type ChannelsCommandsModule = typeof import("../commands/channels.js");
const optionNamesRemove = ["channel", "account", "delete"] as const;
const CHANNEL_ADD_SELECTION_OPTION_NAMES = new Set(["channel"]);

type RegisterChannelsCliOptions = {
  includeSetupOptions?: boolean;
};

type AddChannelSetupOptionsParams = {
  channelId?: string;
  includeAll?: boolean;
};

type ChannelSetupOptionMode = "none" | "modern" | "legacy";
const LEGACY_CHANNEL_SETUP_OPTIONS: readonly ChannelSetupCliOption[] = [
  { flags: "--token <token>", description: "Channel token or credential payload" },
  {
    flags: "--token-file <path>",
    description: "Read channel token or credential payload from file",
  },
  { flags: "--secret <secret>", description: "Channel shared secret" },
  { flags: "--bot-token <token>", description: "Bot token" },
  { flags: "--app-token <token>", description: "App token" },
  { flags: "--password <password>", description: "Channel password or login secret" },
  { flags: "--cli-path <path>", description: "Channel CLI path" },
  { flags: "--url <url>", description: "Channel setup URL" },
  { flags: "--base-url <url>", description: "Channel base URL" },
  { flags: "--http-url <url>", description: "Channel HTTP service URL" },
  { flags: "--auth-dir <path>", description: "Channel auth directory override" },
  {
    flags: "--use-env",
    description: "Use env-backed credentials when supported",
    defaultValue: false,
  },
];

const channelsCommandsLoader = createLazyImportLoader<ChannelsCommandsModule>(
  () => import("../commands/channels.js"),
);
function loadChannelsCommands(): Promise<ChannelsCommandsModule> {
  return channelsCommandsLoader.load();
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

function addChannelSetupOption(
  command: Command,
  option: ChannelSetupCliOption,
  seenFlags: Set<string>,
): void {
  const optionSwitches = getChannelSetupOptionSwitches(option.flags);
  if (optionSwitches.some((flag) => seenFlags.has(flag))) {
    return;
  }
  optionSwitches.forEach((flag) => seenFlags.add(flag));
  if (option.defaultValue !== undefined) {
    command.option(option.flags, option.description, option.defaultValue);
  } else {
    command.option(option.flags, option.description);
  }
  if (option.negatedFlags) {
    const negatedSwitches = getChannelSetupOptionSwitches(option.negatedFlags);
    if (!negatedSwitches.some((flag) => seenFlags.has(flag))) {
      negatedSwitches.forEach((flag) => seenFlags.add(flag));
      command.option(option.negatedFlags, option.description);
    }
  }
}

function shouldRegisterChannelSetupOptions(
  argv: string[] = process.argv,
  options: RegisterChannelsCliOptions = {},
): boolean {
  // Channel-specific setup flags are expensive to load and only needed on `channels add`.
  if (options.includeSetupOptions) {
    return true;
  }
  const { commandPath } = resolveCliArgvInvocation(normalizeWindowsArgv(argv));
  return commandPath[0] === "channels" && commandPath[1] === "add";
}

async function addChannelSetupOptions(
  command: Command,
  params: AddChannelSetupOptionsParams = {},
): Promise<ChannelSetupOptionMode> {
  const { resolveChannelSetupCliOptionMetadata } = await loadChannelSetupCliOptions();
  const selected = params.channelId?.trim().toLowerCase();
  const { options, selectedChannel } = resolveChannelSetupCliOptionMetadata(selected, {
    includeAll: params.includeAll,
  });
  const mode: ChannelSetupOptionMode = selected
    ? selectedChannel?.setup
      ? "modern"
      : "legacy"
    : "none";
  const seenFlags = new Set(
    command.options.flatMap((option) => getChannelSetupOptionSwitches(option.flags)),
  );
  for (const option of options) {
    addChannelSetupOption(command, option, seenFlags);
  }
  if (
    params.includeAll ||
    (mode === "legacy" && (selectedChannel === undefined || selectedChannel.setup === undefined))
  ) {
    for (const option of LEGACY_CHANNEL_SETUP_OPTIONS) {
      addChannelSetupOption(command, option, seenFlags);
    }
  }
  return mode;
}

export async function registerChannelsCli(
  program: Command,
  argv: string[] = process.argv,
  options: RegisterChannelsCliOptions = {},
) {
  const channelNames = formatCliChannelOptions();
  const channels = program
    .command("channels")
    .description("Manage connected chat channels and accounts")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw channels list", "List configured channels."],
          ["openclaw channels list --all", "Show configured, bundled, and installable channels."],
          ["openclaw channels add", "Open guided channel setup."],
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
    .description("List chat channels (configured by default; pass --all for installable catalog)")
    .option("--all", "Include bundled and installable catalog channels", false)
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
    .option("--channel <name>", `Only show one channel (${formatCliChannelOptions(["all"])})`)
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

  const deadLetters = channels
    .command("dead-letters")
    .description("Inspect and resubmit failed inbound channel events");

  deadLetters
    .command("list")
    .description("List failed inbound events for one channel account")
    .requiredOption("--channel <name>", "Channel id")
    .option("--account <id>", "Account id", "default")
    .option("--limit <n>", "Maximum entries", "100")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runChannelsCommand(async () => {
        const { channelsDeadLettersListCommand } =
          await import("../commands/channels/dead-letters.js");
        await channelsDeadLettersListCommand(opts, defaultRuntime);
      });
    });

  deadLetters
    .command("resubmit")
    .description("Re-enqueue one failed inbound event")
    .argument("<event-id>", "Ingress event id")
    .requiredOption("--channel <name>", "Channel id")
    .option("--account <id>", "Account id", "default")
    .option("--json", "Output JSON", false)
    .action(async (eventId, opts) => {
      await runChannelsCommand(async () => {
        const { channelsDeadLettersResubmitCommand } =
          await import("../commands/channels/dead-letters.js");
        await channelsDeadLettersResubmitCommand(eventId, opts, defaultRuntime);
      });
    });

  applyParentDefaultHelpAction(deadLetters);

  const addCommand = channels
    .command("add")
    .description("Add or update a channel account")
    .argument("[channel]", "Channel id")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw channels add", "Open guided setup for available chat channels."],
          [
            "openclaw channels add --channel telegram --token <token>",
            "Add or update Telegram non-interactively.",
          ],
          ["openclaw channels list --all", "Find channel ids before using --channel."],
        ])}\n`,
    )
    .option("--channel <name>", `Channel (${channelNames})`)
    .option("--account <id>", "Account id (default when omitted)")
    .option("--name <name>", "Display name for this account");

  let channelSetupOptionMode: ChannelSetupOptionMode = "none";
  const selectedChannelId = await resolveChannelsAddChannelFromArgv(argv);
  if (
    shouldRegisterChannelSetupOptions(argv, options) &&
    (selectedChannelId !== undefined || options.includeSetupOptions)
  ) {
    channelSetupOptionMode = await addChannelSetupOptions(addCommand, {
      channelId: selectedChannelId,
      includeAll: options.includeSetupOptions,
    });
  }

  addCommand.action(async (channelArg: string | undefined, opts, command) => {
    await runChannelsCommand(async () => {
      const { channelsAddCommand } = await loadChannelsCommands();
      const hasFlags = hasExplicitOptions(
        command,
        getOptionNames(command).filter((name) => !CHANNEL_ADD_SELECTION_OPTION_NAMES.has(name)),
      );
      await channelsAddCommand(
        resolveChannelsAddOptions(
          channelArg,
          opts,
          channelSetupOptionMode === "modern" ? command : undefined,
        ),
        defaultRuntime,
        {
          hasFlags,
          ...(!hasFlags ? { directEntry: true } : {}),
        },
      );
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

  applyParentDefaultHelpAction(channels);
}
