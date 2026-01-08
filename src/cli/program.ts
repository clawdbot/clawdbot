import { Command } from "commander";
import { agentCliCommand } from "../commands/agent-via-gateway.js";
import {
  agentsAddCommand,
  agentsDeleteCommand,
  agentsListCommand,
} from "../commands/agents.js";
import { configureCommand } from "../commands/configure.js";
import { doctorCommand } from "../commands/doctor.js";
import { healthCommand } from "../commands/health.js";
import { onboardCommand } from "../commands/onboard.js";
import { pollCommand } from "../commands/poll.js";
import { sendCommand } from "../commands/send.js";
import { sessionsCommand } from "../commands/sessions.js";
import { setupCommand } from "../commands/setup.js";
import { statusCommand } from "../commands/status.js";
import {
  isNixMode,
  loadConfig,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { danger, setVerbose } from "../globals.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.js";
import { defaultRuntime } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";
import { VERSION } from "../version.js";
import { emitCliBanner, formatCliBannerLine } from "./banner.js";
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
import { registerModelsCli } from "./models-cli.js";
import { registerNodesCli } from "./nodes-cli.js";
import { registerPairingCli } from "./pairing-cli.js";
import { forceFreePort } from "./ports.js";
import { runProviderLogin, runProviderLogout } from "./provider-auth.js";
import { registerProvidersCli } from "./providers-cli.js";
import { registerSkillsCli } from "./skills-cli.js";
import { registerTuiCli } from "./tui-cli.js";

export { forceFreePort };

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function buildProgram() {
  const program = new Command();
  const PROGRAM_VERSION = VERSION;

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
    const line = formatCliBannerLine(PROGRAM_VERSION, { richTty: isRich() });
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
      'clawdbot send --to +15555550123 --message "Hi" --json',
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
      'clawdbot send --provider telegram --to @mychat --message "Hi"',
      "Send via your Telegram bot.",
    ],
  ] as const;

  const fmtExamples = examples
    .map(([cmd, desc]) => `  ${theme.command(cmd)}\n    ${theme.muted(desc)}`)
    .join("\n");

  program.addHelpText(
    "afterAll",
    `\n${theme.heading("Examples:")}\n${fmtExamples}\n`,
  );

  program
    .command("setup")
    .description("Initialize ~/.clawdbot/clawdbot.json and the agent workspace")
    .option(
      "--workspace <dir>",
      "Agent workspace directory (default: ~/clawd; stored as agent.workspace)",
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
    .option("--non-interactive", "Run without prompts", false)
    .option("--mode <mode>", "Wizard mode: local|remote")
    .option(
      "--auth-choice <choice>",
      "Auth: oauth|claude-cli|openai-codex|codex-cli|antigravity|apiKey|minimax|skip",
    )
    .option("--anthropic-api-key <key>", "Anthropic API key")
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
    .option("--daemon-runtime <runtime>", "Daemon runtime: node|bun")
    .option("--skip-skills", "Skip skills setup")
    .option("--skip-health", "Skip health check")
    .option("--node-manager <name>", "Node manager for skills: npm|pnpm|bun")
    .option("--json", "Output JSON summary", false)
    .action(async (opts) => {
      try {
        await onboardCommand(
          {
            workspace: opts.workspace as string | undefined,
            nonInteractive: Boolean(opts.nonInteractive),
            mode: opts.mode as "local" | "remote" | undefined,
            authChoice: opts.authChoice as
              | "oauth"
              | "claude-cli"
              | "openai-codex"
              | "codex-cli"
              | "antigravity"
              | "apiKey"
              | "minimax"
              | "skip"
              | undefined,
            anthropicApiKey: opts.anthropicApiKey as string | undefined,
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
            installDaemon: Boolean(opts.installDaemon),
            daemonRuntime: opts.daemonRuntime as "node" | "bun" | undefined,
            skipSkills: Boolean(opts.skipSkills),
            skipHealth: Boolean(opts.skipHealth),
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
    .action(async () => {
      try {
        await configureCommand(defaultRuntime);
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
    .option(
      "--non-interactive",
      "Run without prompts (safe migrations only)",
      false,
    )
    .option("--deep", "Scan system services for extra gateway installs", false)
    .action(async (opts) => {
      try {
        await doctorCommand(defaultRuntime, {
          workspaceSuggestions: opts.workspaceSuggestions,
          yes: Boolean(opts.yes),
          nonInteractive: Boolean(opts.nonInteractive),
          deep: Boolean(opts.deep),
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

  program
    .command("send")
    .description(
      "Send a message (WhatsApp Web, Telegram bot, Discord, Slack, Signal, iMessage)",
    )
    .requiredOption(
      "-t, --to <number>",
      "Recipient: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord channel/user, or iMessage handle/chat_id",
    )
    .requiredOption("-m, --message <text>", "Message body")
    .option(
      "--media <path-or-url>",
      "Attach media (image/audio/video/document). Accepts local paths or URLs.",
    )
    .option(
      "--gif-playback",
      "Treat video media as GIF playback (WhatsApp only).",
      false,
    )
    .option(
      "--provider <provider>",
      "Delivery provider: whatsapp|telegram|discord|slack|signal|imessage (default: whatsapp)",
    )
    .option("--account <id>", "WhatsApp account id (accountId)")
    .option("--dry-run", "Print payload and skip sending", false)
    .option("--json", "Output result as JSON", false)
    .option("--verbose", "Verbose logging", false)
    .addHelpText(
      "after",
      `
Examples:
  clawdbot send --to +15555550123 --message "Hi"
  clawdbot send --to +15555550123 --message "Hi" --media photo.jpg
  clawdbot send --to +15555550123 --message "Hi" --dry-run      # print payload only
  clawdbot send --to +15555550123 --message "Hi" --json         # machine-readable result`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const deps = createDefaultDeps();
      try {
        await sendCommand(
          {
            ...opts,
            account: opts.account as string | undefined,
          },
          deps,
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("poll")
    .description("Create a poll via WhatsApp or Discord")
    .requiredOption(
      "-t, --to <id>",
      "Recipient: WhatsApp JID/number or Discord channel/user",
    )
    .requiredOption("-q, --question <text>", "Poll question")
    .requiredOption(
      "-o, --option <choice>",
      "Poll option (use multiple times, 2-12 required)",
      (value: string, previous: string[]) => previous.concat([value]),
      [] as string[],
    )
    .option(
      "-s, --max-selections <n>",
      "How many options can be selected (default: 1)",
    )
    .option(
      "--duration-hours <n>",
      "Poll duration in hours (Discord only, default: 24)",
    )
    .option(
      "--provider <provider>",
      "Delivery provider: whatsapp|discord (default: whatsapp)",
    )
    .option("--dry-run", "Print payload and skip sending", false)
    .option("--json", "Output result as JSON", false)
    .option("--verbose", "Verbose logging", false)
    .addHelpText(
      "after",
      `
Examples:
  clawdbot poll --to +15555550123 -q "Lunch today?" -o "Yes" -o "No" -o "Maybe"
  clawdbot poll --to 123456789@g.us -q "Meeting time?" -o "10am" -o "2pm" -o "4pm" -s 2
  clawdbot poll --to channel:123456789 -q "Snack?" -o "Pizza" -o "Sushi" --provider discord
  clawdbot poll --to channel:123456789 -q "Plan?" -o "A" -o "B" --provider discord --duration-hours 48`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const deps = createDefaultDeps();
      try {
        await pollCommand(opts, deps, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
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
      "Delivery provider: whatsapp|telegram|discord|slack|signal|imessage (default: whatsapp)",
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
      `
Examples:
  clawdbot agent --to +15555550123 --message "status update"
  clawdbot agent --session-id 1234 --message "Summarize inbox" --thinking medium
  clawdbot agent --to +15555550123 --message "Trace logs" --verbose on --json
  clawdbot agent --to +15555550123 --message "Summon reply" --deliver
`,
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
  registerModelsCli(program);
  registerNodesCli(program);
  registerTuiCli(program);
  registerCronCli(program);
  registerDnsCli(program);
  registerDocsCli(program);
  registerHooksCli(program);
  registerPairingCli(program);
  registerProvidersCli(program);
  registerSkillsCli(program);

  program
    .command("status")
    .description("Show web session health and recent session recipients")
    .option("--json", "Output JSON instead of text", false)
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

Shows token usage per session when the agent reports it; set agent.contextTokens to see % of your model window.`,
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
