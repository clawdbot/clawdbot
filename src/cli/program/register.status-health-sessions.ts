import type { Command } from "commander";
import { healthCommand } from "../../commands/health.js";
import { sessionsCommand } from "../../commands/sessions.js";
import { statusCommand } from "../../commands/status.js";
import { setVerbose } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { parsePositiveIntOrUndefined } from "./helpers.js";

export function registerStatusHealthSessionsCommands(program: Command) {
  program
    .command("status")
    .description("Show channel health and recent session recipients")
    .option("--json", "Output JSON instead of text", false)
    .option("--all", "Full diagnosis (read-only, pasteable)", false)
    .option("--usage", "Show model provider usage/quota snapshots", false)
    .option("--deep", "Probe channels (WhatsApp Web + Telegram + Discord + Slack + Signal)", false)
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
  clawdbot status --usage           # show model provider usage/quota snapshots
  clawdbot status --deep            # run channel probes (WA + Telegram + Discord + Slack + Signal)
  clawdbot status --deep --timeout 5000 # tighten probe timeout
  clawdbot channels status          # gateway channel runtime + probes`,
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/status", "docs.clawd.bot/cli/status")}\n`,
    )
    .action(async (opts) => {
      const verbose = Boolean(opts.verbose || opts.debug);
      setVerbose(verbose);
      const timeout = parsePositiveIntOrUndefined(opts.timeout);
      if (opts.timeout !== undefined && timeout === undefined) {
        defaultRuntime.error("--timeout must be a positive integer (milliseconds)");
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
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/health", "docs.clawd.bot/cli/health")}\n`,
    )
    .action(async (opts) => {
      const verbose = Boolean(opts.verbose || opts.debug);
      setVerbose(verbose);
      const timeout = parsePositiveIntOrUndefined(opts.timeout);
      if (opts.timeout !== undefined && timeout === undefined) {
        defaultRuntime.error("--timeout must be a positive integer (milliseconds)");
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
    .option("--store <path>", "Path to session store (default: resolved from config)")
    .option("--active <minutes>", "Only show sessions updated within the past N minutes")
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
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/sessions", "docs.clawd.bot/cli/sessions")}\n`,
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
}
