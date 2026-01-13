import { Command } from "commander";
import { agentCliCommand } from "../commands/agent-via-gateway.js";
import {
  agentsAddCommand,
  agentsDeleteCommand,
  agentsListCommand,
} from "../commands/agents.js";
import {
  CONFIGURE_WIZARD_SECTIONS,
  configureCommand,
  configureCommandWithSections,
} from "../commands/configure.js";
import { dashboardCommand } from "../commands/dashboard.js";
import { doctorCommand } from "../commands/doctor.js";
import { healthCommand } from "../commands/health.js";
import { messageCommand } from "../commands/message.js";
import { onboardCommand } from "../commands/onboard.js";
import { resetCommand } from "../commands/reset.js";
import { sessionsCommand } from "../commands/sessions.js";
import { setupCommand } from "../commands/setup.js";
import { statusCommand } from "../commands/status.js";
import { uninstallCommand } from "../commands/uninstall.js";
import {
  isNixMode,
  loadConfig,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { danger, setVerbose } from "../globals.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.js";
import { registerPluginCliCommands } from "../plugins/cli.js";
import { listProviderPlugins } from "../providers/plugins/index.js";
import { DEFAULT_CHAT_PROVIDER } from "../providers/registry.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { isRich, theme } from "../terminal/theme.js";
import { VERSION } from "../version.js";
import {
  emitCliBanner,
  formatCliBannerLine,
  hasEmittedCliBanner,
} from "./banner.js";
import { registerBrowserCli } from "./browser-cli.js";
import { hasExplicitOptions } from "./command-options.js";
import { registerCronCli } from "./cron-cli.js";
import { registerDaemonCli } from "./daemon-cli.js";
import { createDefaultDeps } from "./deps.js";
import { registerDnsCli } from "./dns-cli.js";
import { registerDocsCli } from "./docs-cli.js";
import { registerGatewayCli } from "./gateway-cli.js";
import { registerHooksCli } from "./hooks-cli.js";
import { registerLogsCli } from "./logs-cli.js";
import { registerMemoryCli } from "./memory-cli.js";
import { registerModelsCli } from "./models-cli.js";
import { registerNodesCli } from "./nodes-cli.js";
import { registerPairingCli } from "./pairing-cli.js";
import { registerPluginsCli } from "./plugins-cli.js";
import { forceFreePort } from "./ports.js";
import { runProviderLogin, runProviderLogout } from "./provider-auth.js";
import { registerProvidersCli } from "./providers-cli.js";
import { registerSandboxCli } from "./sandbox-cli.js";
import { registerSkillsCli } from "./skills-cli.js";
import { registerTuiCli } from "./tui-cli.js";
import { registerUpdateCli } from "./update-cli.js";

export { forceFreePort };

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function buildProgram() {
  const program = new Command();
  const PROGRAM_VERSION = VERSION;
  const providerOptions = listProviderPlugins().map((plugin) => plugin.id);
  const messageProviderOptions = providerOptions.join("|");
  const agentProviderOptions = ["last", ...providerOptions].join("|");

  program
    .name("clawdbot")
    .description("")
    .version(PROGRAM_VERSION)
    .option(
      "--dev",
      "Dev profile: isolate state under ~/.clawdbot-dev, default gateway port 19001, and shift derived ports (bridge/browser/canvas)",
    )
    .option(
      "--profile <name>",
      "Use a named profile (isolates CLAWDBOT_STATE_DIR/CLAWDBOT_CONFIG_PATH under ~/.clawdbot-<name>)",
    );

  program.option("--no-color", "Disable ANSI colors", false);

  program.configureHelp({
    optionTerm: (option) => theme.option(option.flags),
    subcommandTerm: (cmd) => theme.command(cmd.name()),
  });

  program.configureOutput({
    writeOut: (str) => {
      const colored = str
        .replace(/^Usage:/gm, theme.heading("Usage:"))
        .replace(/^Options:/gm, theme.heading("Options:"))
        .replace(/^Commands:/gm, theme.heading("Commands:"));
      process.stdout.write(colored);
    },
    writeErr: (str) => process.stderr.write(str),
    outputError: (str, write) => write(theme.error(str)),
  });

  if (
    process.argv.includes("-V") ||
    process.argv.includes("--version") ||
    process.argv.includes("-v")
  ) {
    console.log(PROGRAM_VERSION);
    process.exit(0);
  }

  program.addHelpText("beforeAll", () => {
    if (hasEmittedCliBanner()) return "";
    const rich = isRich();
    const line = formatCliBannerLine(PROGRAM_VERSION, { richTty: rich });
    return `\n${line}\n`;
  });

  program.hook("preAction", async (_thisCommand, actionCommand) => {
    emitCliBanner(PROGRAM_VERSION);
    if (actionCommand.name() === "doctor") return;
    const snapshot = await readConfigFileSnapshot();
    if (snapshot.legacyIssues.length === 0) return;
    if (isNixMode) {
      defaultRuntime.error(
        danger(
          "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and retry.",
        ),
      );
      process.exit(1);
    }
    const migrated = migrateLegacyConfig(snapshot.parsed);
    if (migrated.config) {
      await writeConfigFile(migrated.config);
      if (migrated.changes.length > 0) {
        defaultRuntime.log(
          `Migrated legacy config entries:\n${migrated.changes
            .map((entry) => `- ${entry}`)
            .join("\n")}`,
        );
      }
      return;
    }
    const issues = snapshot.legacyIssues
      .map((issue) => `- ${issue.path}: ${issue.message}`)
      .join("\n");
    defaultRuntime.error(
      danger(
        `Legacy config entries detected. Run "clawdbot doctor" (or ask your agent) to migrate.\n${issues}`,
      ),
    );
    process.exit(1);
  });
  program.hook("preAction", async (_thisCommand, actionCommand) => {
    if (actionCommand.name() === "doctor") return;
    const cfg = loadConfig();
    await autoMigrateLegacyState({ cfg });
  });
  const examples = [
    [
      "clawdbot providers login --verbose",
      "Link personal WhatsApp Web and show QR + connection logs.",
    ],
    [
      'clawdbot message send --to +15555550123 --message "Hi" --json',
      "Send via your web session and print JSON result.",
    ],
    ["clawdbot gateway --port 18789", "Run the WebSocket Gateway locally."],
    [
      "clawdbot --dev gateway",
      "Run a dev Gateway (isolated state/config) on ws://127.0.0.1:19001.",
    ],
    [
      "clawdbot gateway --force",
      "Kill anything bound to the default gateway port, then start it.",
    ],
    ["clawdbot gateway ...", "Gateway control via WebSocket."],
    [
      'clawdbot agent --to +15555550123 --message "Run summary" --deliver',
      "Talk directly to the agent using the Gateway; optionally send the WhatsApp reply.",
    ],
    [
      'clawdbot message send --provider telegram --to @mychat --message "Hi"',
      "Send via your Telegram bot.",
    ],
  ] as const;

  const fmtExamples = examples
    .map(([cmd, desc]) => `  ${theme.command(cmd)}\n    ${theme.muted(desc)}`)
    .join("\n");

  program.addHelpText("afterAll", () => {
    const docs = formatDocsLink("/cli", "docs.clawd.bot/cli");
    return `\n${theme.heading("Examples:")}\n${fmtExamples}\n\n${theme.muted(
      "Docs:",
    )} ${docs}\n`;
  });

  program
    .command("setup")
    .description("Initialize ~/.clawdbot/clawdbot.json and the agent workspace")
    .option(
      "--workspace <dir>",
      "Agent workspace directory (default: ~/clawd; stored as agents.defaults.workspace)",
    )
    .option("--wizard", "Run the interactive onboarding wizard", false)
    .option("--non-interactive", "Run the wizard without prompts", false)
    .option("--mode <mode>", "Wizard mode: local|remote")
    .option("--remote-url <url>", "Remote Gateway WebSocket URL")
    .option("--remote-token <token>", "Remote Gateway token (optional)")
    .action(async (opts, command) => {
      try {
        const hasWizardFlags = hasExplicitOptions(command, [
          "wizard",
          "nonInteractive",
          "mode",
          "remoteUrl",
          "remoteToken",
        ]);
        if (opts.wizard || hasWizardFlags) {
          await onboardCommand(
            {
              workspace: opts.workspace as string | undefined,
              nonInteractive: Boolean(opts.nonInteractive),
              mode: opts.mode as "local" | "remote" | undefined,
              remoteUrl: opts.remoteUrl as string | undefined,
              remoteToken: opts.remoteToken as string | undefined,
            },
            defaultRuntime,
          );
          return;
        }
        await setupCommand(
          { workspace: opts.workspace as string | undefined },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("onboard")
    .description(
      "Interactive wizard to set up the gateway, workspace, and skills",
    )
    .option("--workspace <dir>", "Agent workspace directory (default: ~/clawd)")
    .option(
      "--reset",
      "Reset config + credentials + sessions + workspace before running wizard",
    )
    .option("--non-interactive", "Run without prompts", false)
    .option("--flow <flow>", "Wizard flow: quickstart|advanced")
    .option("--mode <mode>", "Wizard mode: local|remote")
    .option(
      "--auth-choice <choice>",
      "Auth: setup-token|claude-cli|token|openai-codex|openai-api-key|openrouter-api-key|moonshot-api-key|synthetic-api-key|codex-cli|antigravity|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip",
    )
    .option(
      "--token-provider <id>",
      "Token provider id (non-interactive; used with --auth-choice token)",
    )
    .option(
      "--token <token>",
      "Token value (non-interactive; used with --auth-choice token)",
    )
    .option(
      "--token-profile-id <id>",
      "Auth profile id (non-interactive; default: <provider>:manual)",
    )
    .option(
      "--token-expires-in <duration>",
      "Optional token expiry duration (e.g. 365d, 12h)",
    )
    .option("--anthropic-api-key <key>", "Anthropic API key")
    .option("--openai-api-key <key>", "OpenAI API key")
    .option("--openrouter-api-key <key>", "OpenRouter API key")
    .option("--moonshot-api-key <key>", "Moonshot API key")
    .option("--gemini-api-key <key>", "Gemini API key")
    .option("--zai-api-key <key>", "Z.AI API key")
    .option("--minimax-api-key <key>", "MiniMax API key")
    .option("--synthetic-api-key <key>", "Synthetic API key")
    .option("--opencode-zen-api-key <key>", "OpenCode Zen API key")
    .option("--gateway-port <port>", "Gateway port")
    .option("--gateway-bind <mode>", "Gateway bind: loopback|lan|tailnet|auto")
    .option("--gateway-auth <mode>", "Gateway auth: off|token|password")
    .option("--gateway-token <token>", "Gateway token (token auth)")
    .option("--gateway-password <password>", "Gateway password (password auth)")
    .option("--remote-url <url>", "Remote Gateway WebSocket URL")
    .option("--remote-token <token>", "Remote Gateway token (optional)")
    .option("--tailscale <mode>", "Tailscale: off|serve|funnel")
    .option("--tailscale-reset-on-exit", "Reset tailscale serve/funnel on exit")
    .option("--install-daemon", "Install gateway daemon")
    .option("--no-install-daemon", "Skip gateway daemon install")
    .option("--skip-daemon", "Skip gateway daemon install")
    .option("--daemon-runtime <runtime>", "Daemon runtime: node|bun")
    .option("--skip-providers", "Skip provider setup")
    .option("--skip-skills", "Skip skills setup")
    .option("--skip-health", "Skip health check")
    .option("--skip-ui", "Skip Control UI/TUI prompts")
    .option("--node-manager <name>", "Node manager for skills: npm|pnpm|bun")
    .option("--json", "Output JSON summary", false)
    .action(async (opts, command) => {
      try {
        const installDaemon =
          typeof command?.getOptionValueSource === "function"
            ? command.getOptionValueSource("skipDaemon") === "cli"
              ? false
              : command.getOptionValueSource("installDaemon") === "cli"
                ? Boolean(opts.installDaemon)
                : undefined
            : undefined;
        await onboardCommand(
          {
            workspace: opts.workspace as string | undefined,
            nonInteractive: Boolean(opts.nonInteractive),
            flow: opts.flow as "quickstart" | "advanced" | undefined,
            mode: opts.mode as "local" | "remote" | undefined,
            authChoice: opts.authChoice as
              | "oauth"
              | "setup-token"
              | "claude-cli"
              | "token"
              | "openai-codex"
              | "openai-api-key"
              | "openrouter-api-key"
              | "moonshot-api-key"
              | "synthetic-api-key"
              | "codex-cli"
              | "antigravity"
              | "gemini-api-key"
              | "zai-api-key"
              | "apiKey"
              | "minimax-cloud"
              | "minimax-api"
              | "minimax-api-lightning"
              | "minimax"
              | "opencode-zen"
              | "skip"
              | undefined,
            tokenProvider: opts.tokenProvider as string | undefined,
            token: opts.token as string | undefined,
            tokenProfileId: opts.tokenProfileId as string | undefined,
            tokenExpiresIn: opts.tokenExpiresIn as string | undefined,
            anthropicApiKey: opts.anthropicApiKey as string | undefined,
            openaiApiKey: opts.openaiApiKey as string | undefined,
            openrouterApiKey: opts.openrouterApiKey as string | undefined,
            moonshotApiKey: opts.moonshotApiKey as string | undefined,
            geminiApiKey: opts.geminiApiKey as string | undefined,
            zaiApiKey: opts.zaiApiKey as string | undefined,
            minimaxApiKey: opts.minimaxApiKey as string | undefined,
            syntheticApiKey: opts.syntheticApiKey as string | undefined,
            opencodeZenApiKey: opts.opencodeZenApiKey as string | undefined,
            gatewayPort:
              typeof opts.gatewayPort === "string"
                ? Number.parseInt(opts.gatewayPort, 10)
                : undefined,
            gatewayBind: opts.gatewayBind as
              | "loopback"
              | "lan"
              | "tailnet"
              | "auto"
              | undefined,
            gatewayAuth: opts.gatewayAuth as
              | "off"
              | "token"
              | "password"
              | undefined,
            gatewayToken: opts.gatewayToken as string | undefined,
            gatewayPassword: opts.gatewayPassword as string | undefined,
            remoteUrl: opts.remoteUrl as string | undefined,
            remoteToken: opts.remoteToken as string | undefined,
            tailscale: opts.tailscale as "off" | "serve" | "funnel" | undefined,
            tailscaleResetOnExit: Boolean(opts.tailscaleResetOnExit),
            installDaemon,
            daemonRuntime: opts.daemonRuntime as "node" | "bun" | undefined,
            skipProviders: Boolean(opts.skipProviders),
            skipSkills: Boolean(opts.skipSkills),
            skipHealth: Boolean(opts.skipHealth),
            skipUi: Boolean(opts.skipUi),
            nodeManager: opts.nodeManager as "npm" | "pnpm" | "bun" | undefined,
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("configure")
    .alias("config")
    .description(
      "Interactive wizard to update models, providers, skills, and gateway",
    )
    .option(
      "--section <name>",
      `Configure only one section (repeatable). One of: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}`,
      (value, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .action(async (opts) => {
      try {
        const sections: string[] = Array.isArray(opts.section)
          ? opts.section
              .map((value: unknown) =>
                typeof value === "string" ? value.trim() : "",
              )
              .filter(Boolean)
          : [];
        if (sections.length === 0) {
          await configureCommand(defaultRuntime);
          return;
        }

        const invalid = sections.filter(
          (s) => !CONFIGURE_WIZARD_SECTIONS.includes(s as never),
        );
        if (invalid.length > 0) {
          defaultRuntime.error(
            `Invalid --section: ${invalid.join(", ")}. Expected one of: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}.`,
          );
          defaultRuntime.exit(1);
          return;
        }

        await configureCommandWithSections(sections as never, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("doctor")
    .description("Health checks + quick fixes for the gateway and providers")
    .option(
      "--no-workspace-suggestions",
      "Disable workspace memory system suggestions",
      false,
    )
    .option("--yes", "Accept defaults without prompting", false)
    .option("--repair", "Apply recommended repairs without prompting", false)
    .option(
      "--force",
      "Apply aggressive repairs (overwrites custom service config)",
      false,
    )
    .option(
      "--non-interactive",
      "Run without prompts (safe migrations only)",
      false,
    )
    .option(
      "--generate-gateway-token",
      "Generate and configure a gateway token",
      false,
    )
    .option("--deep", "Scan system services for extra gateway installs", false)
    .action(async (opts) => {
      try {
        await doctorCommand(defaultRuntime, {
          workspaceSuggestions: opts.workspaceSuggestions,
          yes: Boolean(opts.yes),
          repair: Boolean(opts.repair),
          force: Boolean(opts.force),
          nonInteractive: Boolean(opts.nonInteractive),
          generateGatewayToken: Boolean(opts.generateGatewayToken),
          deep: Boolean(opts.deep),
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("dashboard")
    .description("Open the Control UI with your current token")
    .option("--no-open", "Print URL but do not launch a browser", false)
    .action(async (opts) => {
      try {
        await dashboardCommand(defaultRuntime, {
          noOpen: Boolean(opts.noOpen),
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("reset")
    .description("Reset local config/state (keeps the CLI installed)")
    .option(
      "--scope <scope>",
      "config|config+creds+sessions|full (default: interactive prompt)",
    )
    .option("--yes", "Skip confirmation prompts", false)
    .option(
      "--non-interactive",
      "Disable prompts (requires --scope + --yes)",
      false,
    )
    .option("--dry-run", "Print actions without removing files", false)
    .action(async (opts) => {
      try {
        await resetCommand(defaultRuntime, {
          scope: opts.scope,
          yes: Boolean(opts.yes),
          nonInteractive: Boolean(opts.nonInteractive),
          dryRun: Boolean(opts.dryRun),
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("uninstall")
    .description("Uninstall the gateway service + local data (CLI remains)")
    .option("--service", "Remove the gateway service", false)
    .option("--state", "Remove state + config", false)
    .option("--workspace", "Remove workspace dirs", false)
    .option("--app", "Remove the macOS app", false)
    .option("--all", "Remove service + state + workspace + app", false)
    .option("--yes", "Skip confirmation prompts", false)
    .option("--non-interactive", "Disable prompts (requires --yes)", false)
    .option("--dry-run", "Print actions without removing files", false)
    .action(async (opts) => {
      try {
        await uninstallCommand(defaultRuntime, {
          service: Boolean(opts.service),
          state: Boolean(opts.state),
          workspace: Boolean(opts.workspace),
          app: Boolean(opts.app),
          all: Boolean(opts.all),
          yes: Boolean(opts.yes),
          nonInteractive: Boolean(opts.nonInteractive),
          dryRun: Boolean(opts.dryRun),
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // Deprecated hidden aliases: use `clawdbot providers login/logout`. Remove in a future major.
  program
    .command("login", { hidden: true })
    .description("Link your personal WhatsApp via QR (web provider)")
    .option("--verbose", "Verbose connection logs", false)
    .option("--provider <provider>", "Provider alias (default: whatsapp)")
    .option("--account <id>", "WhatsApp account id (accountId)")
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
        defaultRuntime.error(danger(`Web login failed: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("logout", { hidden: true })
    .description("Log out of WhatsApp Web (keeps config)")
    .option("--provider <provider>", "Provider alias (default: whatsapp)")
    .option("--account <id>", "WhatsApp account id (accountId)")
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
        defaultRuntime.error(danger(`Logout failed: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });

  const message = program
    .command("message")
    .description("Send messages and provider actions")
    .addHelpText(
      "after",
      () =>
        `
Examples:
  clawdbot message send --to +15555550123 --message "Hi"
  clawdbot message send --to +15555550123 --message "Hi" --media photo.jpg
  clawdbot message poll --provider discord --to channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi
  clawdbot message react --provider discord --to 123 --message-id 456 --emoji "✅"

${theme.muted("Docs:")} ${formatDocsLink("/message", "docs.clawd.bot/message")}`,
    )
    .action(() => {
      message.help({ error: true });
    });

  const withMessageBase = (command: Command) =>
    command
      .option("--provider <provider>", `Provider: ${messageProviderOptions}`)
      .option("--account <id>", "Provider account id")
      .option("--json", "Output result as JSON", false)
      .option("--dry-run", "Print payload and skip sending", false)
      .option("--verbose", "Verbose logging", false);

  const withMessageTarget = (command: Command) =>
    command.option(
      "-t, --to <dest>",
      "Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack channel/user, or iMessage handle/chat_id",
    );
  const withRequiredMessageTarget = (command: Command) =>
    command.requiredOption(
      "-t, --to <dest>",
      "Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack channel/user, or iMessage handle/chat_id",
    );

  const runMessageAction = async (
    action: string,
    opts: Record<string, unknown>,
  ) => {
    setVerbose(Boolean(opts.verbose));
    const deps = createDefaultDeps();
    try {
      await messageCommand(
        {
          ...opts,
          action,
          account: opts.account as string | undefined,
        },
        deps,
        defaultRuntime,
      );
    } catch (err) {
      defaultRuntime.error(String(err));
      defaultRuntime.exit(1);
    }
  };

  withMessageBase(
    withRequiredMessageTarget(
      message
        .command("send")
        .description("Send a message")
        .requiredOption("-m, --message <text>", "Message body"),
    )
      .option(
        "--media <path-or-url>",
        "Attach media (image/audio/video/document). Accepts local paths or URLs.",
      )
      .option(
        "--buttons-json <json>",
        "Telegram inline keyboard buttons as JSON (array of button rows)",
      )
      .option("--reply-to <id>", "Reply-to message id")
      .option("--thread-id <id>", "Thread id (Telegram forum thread)")
      .option(
        "--gif-playback",
        "Treat video media as GIF playback (WhatsApp only).",
        false,
      ),
  ).action(async (opts) => {
    await runMessageAction("send", opts);
  });

  withMessageBase(
    withRequiredMessageTarget(
      message.command("poll").description("Send a poll"),
    ),
  )
    .requiredOption("--poll-question <text>", "Poll question")
    .option(
      "--poll-option <choice>",
      "Poll option (repeat 2-12 times)",
      collectOption,
      [] as string[],
    )
    .option("--poll-multi", "Allow multiple selections", false)
    .option("--poll-duration-hours <n>", "Poll duration (Discord)")
    .option("-m, --message <text>", "Optional message body")
    .action(async (opts) => {
      await runMessageAction("poll", opts);
    });

  withMessageBase(
    withMessageTarget(
      message.command("react").description("Add or remove a reaction"),
    ),
  )
    .requiredOption("--message-id <id>", "Message id")
    .option("--emoji <emoji>", "Emoji for reactions")
    .option("--remove", "Remove reaction", false)
    .option("--participant <id>", "WhatsApp reaction participant")
    .option("--from-me", "WhatsApp reaction fromMe", false)
    .option("--channel-id <id>", "Channel id (defaults to --to)")
    .action(async (opts) => {
      await runMessageAction("react", opts);
    });

  withMessageBase(
    withMessageTarget(
      message.command("reactions").description("List reactions on a message"),
    ),
  )
    .requiredOption("--message-id <id>", "Message id")
    .option("--limit <n>", "Result limit")
    .option("--channel-id <id>", "Channel id (defaults to --to)")
    .action(async (opts) => {
      await runMessageAction("reactions", opts);
    });

  withMessageBase(
    withMessageTarget(
      message.command("read").description("Read recent messages"),
    ),
  )
    .option("--limit <n>", "Result limit")
    .option("--before <id>", "Read/search before id")
    .option("--after <id>", "Read/search after id")
    .option("--around <id>", "Read around id (Discord)")
    .option("--channel-id <id>", "Channel id (defaults to --to)")
    .action(async (opts) => {
      await runMessageAction("read", opts);
    });

  withMessageBase(
    withMessageTarget(
      message
        .command("edit")
        .description("Edit a message")
        .requiredOption("-m, --message <text>", "Message body"),
    ),
  )
    .requiredOption("--message-id <id>", "Message id")
    .option("--channel-id <id>", "Channel id (defaults to --to)")
    .action(async (opts) => {
      await runMessageAction("edit", opts);
    });

  withMessageBase(
    withMessageTarget(
      message.command("delete").description("Delete a message"),
    ),
  )
    .requiredOption("--message-id <id>", "Message id")
    .option("--channel-id <id>", "Channel id (defaults to --to)")
    .action(async (opts) => {
      await runMessageAction("delete", opts);
    });

  withMessageBase(
    withMessageTarget(message.command("pin").description("Pin a message")),
  )
    .requiredOption("--message-id <id>", "Message id")
    .option("--channel-id <id>", "Channel id (defaults to --to)")
    .action(async (opts) => {
      await runMessageAction("pin", opts);
    });

  withMessageBase(
    withMessageTarget(message.command("unpin").description("Unpin a message")),
  )
    .option("--message-id <id>", "Message id")
    .option("--channel-id <id>", "Channel id (defaults to --to)")
    .action(async (opts) => {
      await runMessageAction("unpin", opts);
    });

  withMessageBase(
    withMessageTarget(
      message.command("pins").description("List pinned messages"),
    ),
  )
    .option("--channel-id <id>", "Channel id (defaults to --to)")
    .action(async (opts) => {
      await runMessageAction("list-pins", opts);
    });

  withMessageBase(
    withMessageTarget(
      message.command("permissions").description("Fetch channel permissions"),
    ),
  )
    .option("--channel-id <id>", "Channel id (defaults to --to)")
    .action(async (opts) => {
      await runMessageAction("permissions", opts);
    });

  withMessageBase(
    message.command("search").description("Search Discord messages"),
  )
    .requiredOption("--guild-id <id>", "Guild id")
    .requiredOption("--query <text>", "Search query")
    .option("--channel-id <id>", "Channel id")
    .option(
      "--channel-ids <id>",
      "Channel id (repeat)",
      collectOption,
      [] as string[],
    )
    .option("--author-id <id>", "Author id")
    .option(
      "--author-ids <id>",
      "Author id (repeat)",
      collectOption,
      [] as string[],
    )
    .option("--limit <n>", "Result limit")
    .action(async (opts) => {
      await runMessageAction("search", opts);
    });

  const thread = message.command("thread").description("Thread actions");

  withMessageBase(
    withMessageTarget(
      thread
        .command("create")
        .description("Create a thread")
        .requiredOption("--thread-name <name>", "Thread name"),
    ),
  )
    .option("--channel-id <id>", "Channel id (defaults to --to)")
    .option("--message-id <id>", "Message id (optional)")
    .option("--auto-archive-min <n>", "Thread auto-archive minutes")
    .action(async (opts) => {
      await runMessageAction("thread-create", opts);
    });

  withMessageBase(
    thread
      .command("list")
      .description("List threads")
      .requiredOption("--guild-id <id>", "Guild id"),
  )
    .option("--channel-id <id>", "Channel id")
    .option("--include-archived", "Include archived threads", false)
    .option("--before <id>", "Read/search before id")
    .option("--limit <n>", "Result limit")
    .action(async (opts) => {
      await runMessageAction("thread-list", opts);
    });

  withMessageBase(
    withRequiredMessageTarget(
      thread
        .command("reply")
        .description("Reply in a thread")
        .requiredOption("-m, --message <text>", "Message body"),
    ),
  )
    .option(
      "--media <path-or-url>",
      "Attach media (image/audio/video/document). Accepts local paths or URLs.",
    )
    .option("--reply-to <id>", "Reply-to message id")
    .action(async (opts) => {
      await runMessageAction("thread-reply", opts);
    });

  const emoji = message.command("emoji").description("Emoji actions");
  withMessageBase(emoji.command("list").description("List emojis"))
    .option("--guild-id <id>", "Guild id (Discord)")
    .action(async (opts) => {
      await runMessageAction("emoji-list", opts);
    });

  withMessageBase(
    emoji
      .command("upload")
      .description("Upload an emoji")
      .requiredOption("--guild-id <id>", "Guild id"),
  )
    .requiredOption("--emoji-name <name>", "Emoji name")
    .requiredOption("--media <path-or-url>", "Emoji media (path or URL)")
    .option(
      "--role-ids <id>",
      "Role id (repeat)",
      collectOption,
      [] as string[],
    )
    .action(async (opts) => {
      await runMessageAction("emoji-upload", opts);
    });

  const sticker = message.command("sticker").description("Sticker actions");
  withMessageBase(
    withRequiredMessageTarget(
      sticker.command("send").description("Send stickers"),
    ),
  )
    .requiredOption("--sticker-id <id>", "Sticker id (repeat)", collectOption)
    .option("-m, --message <text>", "Optional message body")
    .action(async (opts) => {
      await runMessageAction("sticker", opts);
    });

  withMessageBase(
    sticker
      .command("upload")
      .description("Upload a sticker")
      .requiredOption("--guild-id <id>", "Guild id"),
  )
    .requiredOption("--sticker-name <name>", "Sticker name")
    .requiredOption("--sticker-desc <text>", "Sticker description")
    .requiredOption("--sticker-tags <tags>", "Sticker tags")
    .requiredOption("--media <path-or-url>", "Sticker media (path or URL)")
    .action(async (opts) => {
      await runMessageAction("sticker-upload", opts);
    });

  const role = message.command("role").description("Role actions");
  withMessageBase(
    role
      .command("info")
      .description("List roles")
      .requiredOption("--guild-id <id>", "Guild id"),
  ).action(async (opts) => {
    await runMessageAction("role-info", opts);
  });

  withMessageBase(
    role
      .command("add")
      .description("Add role to a member")
      .requiredOption("--guild-id <id>", "Guild id")
      .requiredOption("--user-id <id>", "User id")
      .requiredOption("--role-id <id>", "Role id"),
  ).action(async (opts) => {
    await runMessageAction("role-add", opts);
  });

  withMessageBase(
    role
      .command("remove")
      .description("Remove role from a member")
      .requiredOption("--guild-id <id>", "Guild id")
      .requiredOption("--user-id <id>", "User id")
      .requiredOption("--role-id <id>", "Role id"),
  ).action(async (opts) => {
    await runMessageAction("role-remove", opts);
  });

  const channel = message.command("channel").description("Channel actions");
  withMessageBase(
    channel
      .command("info")
      .description("Fetch channel info")
      .requiredOption("--channel-id <id>", "Channel id"),
  ).action(async (opts) => {
    await runMessageAction("channel-info", opts);
  });

  withMessageBase(
    channel
      .command("list")
      .description("List channels")
      .requiredOption("--guild-id <id>", "Guild id"),
  ).action(async (opts) => {
    await runMessageAction("channel-list", opts);
  });

  const member = message.command("member").description("Member actions");
  withMessageBase(
    member
      .command("info")
      .description("Fetch member info")
      .requiredOption("--user-id <id>", "User id"),
  )
    .option("--guild-id <id>", "Guild id (Discord)")
    .action(async (opts) => {
      await runMessageAction("member-info", opts);
    });

  const voice = message.command("voice").description("Voice actions");
  withMessageBase(
    voice
      .command("status")
      .description("Fetch voice status")
      .requiredOption("--guild-id <id>", "Guild id")
      .requiredOption("--user-id <id>", "User id"),
  ).action(async (opts) => {
    await runMessageAction("voice-status", opts);
  });

  const event = message.command("event").description("Event actions");
  withMessageBase(
    event
      .command("list")
      .description("List scheduled events")
      .requiredOption("--guild-id <id>", "Guild id"),
  ).action(async (opts) => {
    await runMessageAction("event-list", opts);
  });

  withMessageBase(
    event
      .command("create")
      .description("Create a scheduled event")
      .requiredOption("--guild-id <id>", "Guild id")
      .requiredOption("--event-name <name>", "Event name")
      .requiredOption("--start-time <iso>", "Event start time"),
  )
    .option("--end-time <iso>", "Event end time")
    .option("--desc <text>", "Event description")
    .option("--channel-id <id>", "Channel id")
    .option("--location <text>", "Event location")
    .option("--event-type <stage|external|voice>", "Event type")
    .action(async (opts) => {
      await runMessageAction("event-create", opts);
    });

  withMessageBase(
    message
      .command("timeout")
      .description("Timeout a member")
      .requiredOption("--guild-id <id>", "Guild id")
      .requiredOption("--user-id <id>", "User id"),
  )
    .option("--duration-min <n>", "Timeout duration minutes")
    .option("--until <iso>", "Timeout until")
    .option("--reason <text>", "Moderation reason")
    .action(async (opts) => {
      await runMessageAction("timeout", opts);
    });

  withMessageBase(
    message
      .command("kick")
      .description("Kick a member")
      .requiredOption("--guild-id <id>", "Guild id")
      .requiredOption("--user-id <id>", "User id"),
  )
    .option("--reason <text>", "Moderation reason")
    .action(async (opts) => {
      await runMessageAction("kick", opts);
    });

  withMessageBase(
    message
      .command("ban")
      .description("Ban a member")
      .requiredOption("--guild-id <id>", "Guild id")
      .requiredOption("--user-id <id>", "User id"),
  )
    .option("--reason <text>", "Moderation reason")
    .option("--delete-days <n>", "Ban delete message days")
    .action(async (opts) => {
      await runMessageAction("ban", opts);
    });

  program
    .command("agent")
    .description("Run an agent turn via the Gateway (use --local for embedded)")
    .requiredOption("-m, --message <text>", "Message body for the agent")
    .option(
      "-t, --to <number>",
      "Recipient number in E.164 used to derive the session key",
    )
    .option("--session-id <id>", "Use an explicit session id")
    .option(
      "--thinking <level>",
      "Thinking level: off | minimal | low | medium | high",
    )
    .option("--verbose <on|off>", "Persist agent verbose level for the session")
    .option(
      "--provider <provider>",
      `Delivery provider: ${agentProviderOptions} (default: ${DEFAULT_CHAT_PROVIDER})`,
    )
    .option(
      "--local",
      "Run the embedded agent locally (requires provider API keys in your shell)",
      false,
    )
    .option(
      "--deliver",
      "Send the agent's reply back to the selected provider (requires --to)",
      false,
    )
    .option("--json", "Output result as JSON", false)
    .option(
      "--timeout <seconds>",
      "Override agent command timeout (seconds, default 600 or config value)",
    )
    .addHelpText(
      "after",
      () =>
        `
Examples:
  clawdbot agent --to +15555550123 --message "status update"
  clawdbot agent --session-id 1234 --message "Summarize inbox" --thinking medium
  clawdbot agent --to +15555550123 --message "Trace logs" --verbose on --json
  clawdbot agent --to +15555550123 --message "Summon reply" --deliver

${theme.muted("Docs:")} ${formatDocsLink(
          "/agent-send",
          "docs.clawd.bot/agent-send",
        )}`,
    )
    .action(async (opts) => {
      const verboseLevel =
        typeof opts.verbose === "string" ? opts.verbose.toLowerCase() : "";
      setVerbose(verboseLevel === "on");
      // Build default deps (keeps parity with other commands; future-proofing).
      const deps = createDefaultDeps();
      try {
        await agentCliCommand(opts, defaultRuntime, deps);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  const agents = program
    .command("agents")
    .description("Manage isolated agents (workspaces + auth + routing)");

  agents
    .command("list")
    .description("List configured agents")
    .option("--json", "Output JSON instead of text", false)
    .option("--bindings", "Include routing bindings", false)
    .action(async (opts) => {
      try {
        await agentsListCommand(
          { json: Boolean(opts.json), bindings: Boolean(opts.bindings) },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  agents
    .command("add [name]")
    .description("Add a new isolated agent")
    .option("--workspace <dir>", "Workspace directory for the new agent")
    .option("--model <id>", "Model id for this agent")
    .option("--agent-dir <dir>", "Agent state directory for this agent")
    .option(
      "--bind <provider[:accountId]>",
      "Route provider binding (repeatable)",
      collectOption,
      [],
    )
    .option("--non-interactive", "Disable prompts; requires --workspace", false)
    .option("--json", "Output JSON summary", false)
    .action(async (name, opts, command) => {
      try {
        const hasFlags = hasExplicitOptions(command, [
          "workspace",
          "model",
          "agentDir",
          "bind",
          "nonInteractive",
        ]);
        await agentsAddCommand(
          {
            name: typeof name === "string" ? name : undefined,
            workspace: opts.workspace as string | undefined,
            model: opts.model as string | undefined,
            agentDir: opts.agentDir as string | undefined,
            bind: Array.isArray(opts.bind)
              ? (opts.bind as string[])
              : undefined,
            nonInteractive: Boolean(opts.nonInteractive),
            json: Boolean(opts.json),
          },
          defaultRuntime,
          { hasFlags },
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  agents
    .command("delete <id>")
    .description("Delete an agent and prune workspace/state")
    .option("--force", "Skip confirmation", false)
    .option("--json", "Output JSON summary", false)
    .action(async (id, opts) => {
      try {
        await agentsDeleteCommand(
          {
            id: String(id),
            force: Boolean(opts.force),
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  agents.action(async () => {
    try {
      await agentsListCommand({}, defaultRuntime);
    } catch (err) {
      defaultRuntime.error(String(err));
      defaultRuntime.exit(1);
    }
  });

  registerDaemonCli(program);
  registerGatewayCli(program);
  registerLogsCli(program);
  registerMemoryCli(program);
  registerModelsCli(program);
  registerNodesCli(program);
  registerSandboxCli(program);
  registerTuiCli(program);
  registerCronCli(program);
  registerDnsCli(program);
  registerDocsCli(program);
  registerHooksCli(program);
  registerPairingCli(program);
  registerPluginsCli(program);
  registerProvidersCli(program);
  registerSkillsCli(program);
  registerUpdateCli(program);
  registerPluginCliCommands(program, loadConfig());

  program
    .command("status")
    .description("Show provider health and recent session recipients")
    .option("--json", "Output JSON instead of text", false)
    .option("--all", "Full diagnosis (read-only, pasteable)", false)
    .option("--usage", "Show provider usage/quota snapshots", false)
    .option(
      "--deep",
      "Probe providers (WhatsApp Web + Telegram + Discord + Slack + Signal)",
      false,
    )
    .option("--timeout <ms>", "Probe timeout in milliseconds", "10000")
    .option("--verbose", "Verbose logging", false)
    .option("--debug", "Alias for --verbose", false)
    .addHelpText(
      "after",
      `
Examples:
  clawdbot status                   # show linked account + session store summary
  clawdbot status --all             # full diagnosis (read-only)
  clawdbot status --json            # machine-readable output
  clawdbot status --usage           # show provider usage/quota snapshots
  clawdbot status --deep            # run provider probes (WA + Telegram + Discord + Slack + Signal)
  clawdbot status --deep --timeout 5000 # tighten probe timeout
  clawdbot providers status         # gateway provider runtime + probes`,
    )
    .action(async (opts) => {
      const verbose = Boolean(opts.verbose || opts.debug);
      setVerbose(verbose);
      const timeout = opts.timeout
        ? Number.parseInt(String(opts.timeout), 10)
        : undefined;
      if (timeout !== undefined && (Number.isNaN(timeout) || timeout <= 0)) {
        defaultRuntime.error(
          "--timeout must be a positive integer (milliseconds)",
        );
        defaultRuntime.exit(1);
        return;
      }
      try {
        await statusCommand(
          {
            json: Boolean(opts.json),
            all: Boolean(opts.all),
            deep: Boolean(opts.deep),
            usage: Boolean(opts.usage),
            timeoutMs: timeout,
            verbose,
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("health")
    .description("Fetch health from the running gateway")
    .option("--json", "Output JSON instead of text", false)
    .option("--timeout <ms>", "Connection timeout in milliseconds", "10000")
    .option("--verbose", "Verbose logging", false)
    .option("--debug", "Alias for --verbose", false)
    .action(async (opts) => {
      const verbose = Boolean(opts.verbose || opts.debug);
      setVerbose(verbose);
      const timeout = opts.timeout
        ? Number.parseInt(String(opts.timeout), 10)
        : undefined;
      if (timeout !== undefined && (Number.isNaN(timeout) || timeout <= 0)) {
        defaultRuntime.error(
          "--timeout must be a positive integer (milliseconds)",
        );
        defaultRuntime.exit(1);
        return;
      }
      try {
        await healthCommand(
          {
            json: Boolean(opts.json),
            timeoutMs: timeout,
            verbose,
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("sessions")
    .description("List stored conversation sessions")
    .option("--json", "Output as JSON", false)
    .option("--verbose", "Verbose logging", false)
    .option(
      "--store <path>",
      "Path to session store (default: resolved from config)",
    )
    .option(
      "--active <minutes>",
      "Only show sessions updated within the past N minutes",
    )
    .addHelpText(
      "after",
      `
Examples:
  clawdbot sessions                 # list all sessions
  clawdbot sessions --active 120    # only last 2 hours
  clawdbot sessions --json          # machine-readable output
  clawdbot sessions --store ./tmp/sessions.json

Shows token usage per session when the agent reports it; set agents.defaults.contextTokens to see % of your model window.`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      await sessionsCommand(
        {
          json: Boolean(opts.json),
          store: opts.store as string | undefined,
          active: opts.active as string | undefined,
        },
        defaultRuntime,
      );
    });

  registerBrowserCli(program);

  return program;
}
