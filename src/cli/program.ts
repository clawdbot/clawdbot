import chalk from "chalk";
import { Command } from "commander";
import { sendCommand } from "../commands/send.js";
import { statusCommand } from "../commands/status.js";
import { webhookCommand } from "../commands/webhook.js";
import { loadConfig } from "../config/config.js";
import { ensureTwilioEnv } from "../env.js";
import { danger, info, setVerbose, setYes } from "../globals.js";
import { getResolvedLoggerSettings } from "../logging.js";
import {
  loginWeb,
  logoutWeb,
  monitorWebProvider,
  pickProvider,
  resolveHeartbeatRecipients,
  runWebHeartbeatOnce,
  type WebMonitorTuning,
} from "../provider-web.js";
import { defaultRuntime } from "../runtime.js";
import { runTwilioHeartbeatOnce } from "../twilio/heartbeat.js";
import type { Provider } from "../utils.js";
import { VERSION } from "../version.js";
import {
  resolveHeartbeatSeconds,
  resolveReconnectPolicy,
} from "../web/reconnect.js";
import {
  createDefaultDeps,
  logTwilioFrom,
  logWebSelfId,
  monitorTwilio,
} from "./deps.js";
import { spawnRelayTmux } from "./relay_tmux.js";

export function buildProgram() {
  const program = new Command();
  const PROGRAM_VERSION = VERSION;
  const TAGLINE =
    "Send, receive, and auto-reply on WhatsApp—Twilio-backed or QR-linked.";

  program
    .name("warelay")
    .description("WhatsApp relay CLI (Twilio or WhatsApp Web session)")
    .version(PROGRAM_VERSION);

  const formatIntroLine = (version: string, rich = true) => {
    const base = `📡 warelay ${version} — ${TAGLINE}`;
    return rich && chalk.level > 0
      ? `${chalk.bold.cyan("📡 warelay")} ${chalk.white(version)} ${chalk.gray("—")} ${chalk.green(TAGLINE)}`
      : base;
  };

  program.configureHelp({
    optionTerm: (option) => chalk.yellow(option.flags),
    subcommandTerm: (cmd) => chalk.green(cmd.name()),
  });

  program.configureOutput({
    writeOut: (str) => {
      const colored = str
        .replace(/^Usage:/gm, chalk.bold.cyan("Usage:"))
        .replace(/^Options:/gm, chalk.bold.cyan("Options:"))
        .replace(/^Commands:/gm, chalk.bold.cyan("Commands:"));
      process.stdout.write(colored);
    },
    writeErr: (str) => process.stderr.write(str),
    outputError: (str, write) => write(chalk.red(str)),
  });

  if (process.argv.includes("-V") || process.argv.includes("--version")) {
    console.log(formatIntroLine(PROGRAM_VERSION));
    process.exit(0);
  }

  program.addHelpText("beforeAll", `\n${formatIntroLine(PROGRAM_VERSION)}\n`);
  const examples = [
    [
      "warelay login --verbose",
      "Link personal WhatsApp Web and show QR + connection logs.",
    ],
    [
      'warelay send --to +15551234567 --message "Hi" --provider web --json',
      "Send via your web session and print JSON result.",
    ],
    [
      "warelay relay --provider auto --interval 5 --lookback 15 --verbose",
      "Auto-reply loop: prefer Web when logged in, otherwise Twilio polling.",
    ],
    [
      "warelay webhook --ingress tailscale --port 42873 --path /webhook/whatsapp --verbose",
      "Start webhook + Tailscale Funnel and update Twilio callbacks.",
    ],
    [
      "warelay status --limit 10 --lookback 60 --json",
      "Show last 10 messages from the past hour as JSON.",
    ],
  ] as const;

  const fmtExamples = examples
    .map(([cmd, desc]) => `  ${chalk.green(cmd)}\n    ${chalk.gray(desc)}`)
    .join("\n");

  program.addHelpText(
    "afterAll",
    `\n${chalk.bold.cyan("Examples:")}\n${fmtExamples}\n`,
  );

  program
    .command("login")
    .description("Link your personal WhatsApp via QR (web provider)")
    .option("--verbose", "Verbose connection logs", false)
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      try {
        await loginWeb(Boolean(opts.verbose));
      } catch (err) {
        defaultRuntime.error(danger(`Web login failed: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("logout")
    .description("Clear cached WhatsApp Web credentials")
    .action(async () => {
      try {
        await logoutWeb(defaultRuntime);
      } catch (err) {
        defaultRuntime.error(danger(`Logout failed: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("send")
    .description("Send a WhatsApp message")
    .requiredOption(
      "-t, --to <number>",
      "Recipient number in E.164 (e.g. +15551234567)",
    )
    .requiredOption("-m, --message <text>", "Message body")
    .option(
      "--media <path-or-url>",
      "Attach image (<=5MB). Web: path or URL. Twilio: https URL or local path hosted via webhook/funnel.",
    )
    .option(
      "--serve-media",
      "For Twilio: start a temporary media server if webhook is not running",
      false,
    )
    .option(
      "-w, --wait <seconds>",
      "Wait for delivery status (0 to skip)",
      "20",
    )
    .option("-p, --poll <seconds>", "Polling interval while waiting", "2")
    .option("--provider <provider>", "Provider: twilio | web", "twilio")
    .option("--dry-run", "Print payload and skip sending", false)
    .option("--json", "Output result as JSON", false)
    .option("--verbose", "Verbose logging", false)
    .addHelpText(
      "after",
      `
Examples:
  warelay send --to +15551234567 --message "Hi"                # wait 20s for delivery (default)
  warelay send --to +15551234567 --message "Hi" --wait 0       # fire-and-forget
  warelay send --to +15551234567 --message "Hi" --dry-run      # print payload only
  warelay send --to +15551234567 --message "Hi" --wait 60 --poll 3`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const deps = createDefaultDeps();
      try {
        await sendCommand(opts, deps, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("heartbeat")
    .description(
      "Trigger a heartbeat or manual send once (web or twilio, no tmux)",
    )
    .option("--provider <provider>", "auto | web | twilio", "auto")
    .option("--to <number>", "Override target E.164; defaults to allowFrom[0]")
    .option(
      "--session-id <id>",
      "Force a session id for this heartbeat (resumes a specific Claude session)",
    )
    .option(
      "--all",
      "Send heartbeat to all active sessions (or allowFrom entries when none)",
      false,
    )
    .option(
      "--message <text>",
      "Send a custom message instead of the heartbeat probe (web or twilio provider)",
    )
    .option("--body <text>", "Alias for --message")
    .option("--dry-run", "Print the resolved payload without sending", false)
    .option("--verbose", "Verbose logging", false)
    .addHelpText(
      "after",
      `
Examples:
  warelay heartbeat                 # uses web session + first allowFrom contact
  warelay heartbeat --verbose       # prints detailed heartbeat logs
  warelay heartbeat --to +1555123   # override destination
  warelay heartbeat --session-id <uuid> --to +1555123   # resume a specific session
  warelay heartbeat --message "Ping" --provider twilio
  warelay heartbeat --all           # send to every active session recipient or allowFrom entry`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const cfg = loadConfig();
      const allowAll = Boolean(opts.all);
      const resolution = resolveHeartbeatRecipients(cfg, {
        to: opts.to,
        all: allowAll,
      });
      if (
        !opts.to &&
        !allowAll &&
        resolution.source === "session-ambiguous" &&
        resolution.recipients.length > 1
      ) {
        defaultRuntime.error(
          danger(
            `Multiple active sessions found (${resolution.recipients.join(", ")}). Pass --to <E.164> or --all to send to all.`,
          ),
        );
        defaultRuntime.exit(1);
      }
      const recipients = resolution.recipients;
      if (!recipients || recipients.length === 0) {
        defaultRuntime.error(
          danger(
            "No destination found. Add inbound.allowFrom numbers or pass --to <E.164>.",
          ),
        );
        defaultRuntime.exit(1);
      }
      const providerPref = String(opts.provider ?? "auto");
      if (!["auto", "web", "twilio"].includes(providerPref)) {
        defaultRuntime.error("--provider must be auto, web, or twilio");
        defaultRuntime.exit(1);
      }

      const overrideBody =
        (opts.message as string | undefined) ||
        (opts.body as string | undefined) ||
        undefined;
      const dryRun = Boolean(opts.dryRun);

      const provider =
        providerPref === "twilio"
          ? "twilio"
          : await pickProvider(providerPref as "auto" | "web");
      if (provider === "twilio") ensureTwilioEnv();

      try {
        for (const to of recipients) {
          if (provider === "web") {
            await runWebHeartbeatOnce({
              to,
              verbose: Boolean(opts.verbose),
              runtime: defaultRuntime,
              sessionId: opts.sessionId,
              overrideBody,
              dryRun,
            });
          } else {
            await runTwilioHeartbeatOnce({
              to,
              verbose: Boolean(opts.verbose),
              runtime: defaultRuntime,
              overrideBody,
              dryRun,
            });
          }
        }
      } catch {
        defaultRuntime.exit(1);
      }
    });

  program
    .command("relay")
    .description("Auto-reply to inbound messages (auto-selects web or twilio)")
    .option("--provider <provider>", "auto | web | twilio", "auto")
    .option("-i, --interval <seconds>", "Polling interval for twilio mode", "5")
    .option(
      "-l, --lookback <minutes>",
      "Initial lookback window for twilio mode",
      "5",
    )
    .option(
      "--web-heartbeat <seconds>",
      "Heartbeat interval for web relay health logs (seconds)",
    )
    .option(
      "--web-retries <count>",
      "Max consecutive web reconnect attempts before exit (0 = unlimited)",
    )
    .option(
      "--web-retry-initial <ms>",
      "Initial reconnect backoff for web relay (ms)",
    )
    .option("--web-retry-max <ms>", "Max reconnect backoff for web relay (ms)")
    .option(
      "--heartbeat-now",
      "Run a heartbeat immediately when relay starts (web or twilio provider)",
      false,
    )
    .option("--verbose", "Verbose logging", false)
    .addHelpText(
      "after",
      `
Examples:
  warelay relay                     # auto: web if logged-in, else twilio poll
  warelay relay --provider web      # force personal web session
  warelay relay --provider twilio   # force twilio poll
  warelay relay --provider twilio --interval 2 --lookback 30
  # Troubleshooting: docs/refactor/web-relay-troubleshooting.md
`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const { file: logFile, level: logLevel } = getResolvedLoggerSettings();
      defaultRuntime.log(info(`logs: ${logFile} (level ${logLevel})`));
      const providerPref = String(opts.provider ?? "auto");
      if (!["auto", "web", "twilio"].includes(providerPref)) {
        defaultRuntime.error("--provider must be auto, web, or twilio");
        defaultRuntime.exit(1);
      }
      const intervalSeconds = Number.parseInt(opts.interval, 10);
      const lookbackMinutes = Number.parseInt(opts.lookback, 10);
      const webHeartbeat =
        opts.webHeartbeat !== undefined
          ? Number.parseInt(String(opts.webHeartbeat), 10)
          : undefined;
      const webRetries =
        opts.webRetries !== undefined
          ? Number.parseInt(String(opts.webRetries), 10)
          : undefined;
      const webRetryInitial =
        opts.webRetryInitial !== undefined
          ? Number.parseInt(String(opts.webRetryInitial), 10)
          : undefined;
      const webRetryMax =
        opts.webRetryMax !== undefined
          ? Number.parseInt(String(opts.webRetryMax), 10)
          : undefined;
      const heartbeatNow = Boolean(opts.heartbeatNow);
      if (Number.isNaN(intervalSeconds) || intervalSeconds <= 0) {
        defaultRuntime.error("Interval must be a positive integer");
        defaultRuntime.exit(1);
      }
      if (Number.isNaN(lookbackMinutes) || lookbackMinutes < 0) {
        defaultRuntime.error("Lookback must be >= 0 minutes");
        defaultRuntime.exit(1);
      }
      if (
        webHeartbeat !== undefined &&
        (Number.isNaN(webHeartbeat) || webHeartbeat <= 0)
      ) {
        defaultRuntime.error("--web-heartbeat must be a positive integer");
        defaultRuntime.exit(1);
      }
      if (
        webRetries !== undefined &&
        (Number.isNaN(webRetries) || webRetries < 0)
      ) {
        defaultRuntime.error("--web-retries must be >= 0");
        defaultRuntime.exit(1);
      }
      if (
        webRetryInitial !== undefined &&
        (Number.isNaN(webRetryInitial) || webRetryInitial <= 0)
      ) {
        defaultRuntime.error("--web-retry-initial must be a positive integer");
        defaultRuntime.exit(1);
      }
      if (
        webRetryMax !== undefined &&
        (Number.isNaN(webRetryMax) || webRetryMax <= 0)
      ) {
        defaultRuntime.error("--web-retry-max must be a positive integer");
        defaultRuntime.exit(1);
      }
      if (
        webRetryMax !== undefined &&
        webRetryInitial !== undefined &&
        webRetryMax < webRetryInitial
      ) {
        defaultRuntime.error("--web-retry-max must be >= --web-retry-initial");
        defaultRuntime.exit(1);
      }

      const webTuning: WebMonitorTuning = {};
      if (webHeartbeat !== undefined) webTuning.heartbeatSeconds = webHeartbeat;
      if (heartbeatNow) webTuning.replyHeartbeatNow = true;
      const reconnect: WebMonitorTuning["reconnect"] = {};
      if (webRetries !== undefined) reconnect.maxAttempts = webRetries;
      if (webRetryInitial !== undefined) reconnect.initialMs = webRetryInitial;
      if (webRetryMax !== undefined) reconnect.maxMs = webRetryMax;
      if (Object.keys(reconnect).length > 0) {
        webTuning.reconnect = reconnect;
      }

      const provider = await pickProvider(providerPref as Provider | "auto");

      if (provider === "web") {
        logWebSelfId(defaultRuntime, true);
        const cfg = loadConfig();
        const effectiveHeartbeat = resolveHeartbeatSeconds(
          cfg,
          webTuning.heartbeatSeconds,
        );
        const effectivePolicy = resolveReconnectPolicy(
          cfg,
          webTuning.reconnect,
        );
        defaultRuntime.log(
          info(
            `Web relay health: heartbeat ${effectiveHeartbeat}s, retries ${effectivePolicy.maxAttempts || "∞"}, backoff ${effectivePolicy.initialMs}→${effectivePolicy.maxMs}ms x${effectivePolicy.factor} (jitter ${Math.round(effectivePolicy.jitter * 100)}%)`,
          ),
        );
        try {
          await monitorWebProvider(
            Boolean(opts.verbose),
            undefined,
            true,
            undefined,
            defaultRuntime,
            undefined,
            webTuning,
          );
          return;
        } catch (err) {
          defaultRuntime.error(
            danger(
              `Web relay failed: ${String(err)}. Not falling back; re-link with 'warelay login --provider web'.`,
            ),
          );
          defaultRuntime.exit(1);
        }
      }

      ensureTwilioEnv();
      logTwilioFrom();
      await monitorTwilio(intervalSeconds, lookbackMinutes);
    });

  program
    .command("relay:heartbeat")
    .description(
      "Run relay with an immediate heartbeat (no tmux); requires web provider",
    )
    .option("--provider <provider>", "auto | web", "auto")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const { file: logFile, level: logLevel } = getResolvedLoggerSettings();
      defaultRuntime.log(info(`logs: ${logFile} (level ${logLevel})`));
      const providerPref = String(opts.provider ?? "auto");
      if (!["auto", "web"].includes(providerPref)) {
        defaultRuntime.error("--provider must be auto or web");
        defaultRuntime.exit(1);
        return;
      }
      const provider = await pickProvider(providerPref as "auto" | "web");
      if (provider !== "web") {
        defaultRuntime.error(
          danger(
            "Heartbeat relay is only supported for the web provider. Link with `warelay login --verbose`.",
          ),
        );
        defaultRuntime.exit(1);
        return;
      }

      logWebSelfId(defaultRuntime, true);
      const cfg = loadConfig();
      const effectiveHeartbeat = resolveHeartbeatSeconds(cfg, undefined);
      const effectivePolicy = resolveReconnectPolicy(cfg, undefined);
      defaultRuntime.log(
        info(
          `Web relay health: heartbeat ${effectiveHeartbeat}s, retries ${effectivePolicy.maxAttempts || "∞"}, backoff ${effectivePolicy.initialMs}→${effectivePolicy.maxMs}ms x${effectivePolicy.factor} (jitter ${Math.round(effectivePolicy.jitter * 100)}%)`,
        ),
      );

      try {
        await monitorWebProvider(
          Boolean(opts.verbose),
          undefined,
          true,
          undefined,
          defaultRuntime,
          undefined,
          { replyHeartbeatNow: true },
        );
      } catch (err) {
        defaultRuntime.error(
          danger(
            `Web relay failed: ${String(err)}. Re-link with 'warelay login --provider web'.`,
          ),
        );
        defaultRuntime.exit(1);
      }
    });

  program
    .command("status")
    .description("Show recent WhatsApp messages (sent and received)")
    .option("-l, --limit <count>", "Number of messages to show", "20")
    .option("-b, --lookback <minutes>", "How far back to fetch messages", "240")
    .option("--json", "Output JSON instead of text", false)
    .option("--verbose", "Verbose logging", false)
    .addHelpText(
      "after",
      `
Examples:
  warelay status                            # last 20 msgs in past 4h
  warelay status --limit 5 --lookback 30    # last 5 msgs in past 30m
  warelay status --json --limit 50          # machine-readable output`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const deps = createDefaultDeps();
      try {
        await statusCommand(opts, deps, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("webhook")
    .description(
      "Run inbound webhook. ingress=tailscale updates Twilio; ingress=none stays local-only.",
    )
    .option("-p, --port <port>", "Port to listen on", "42873")
    .option("-r, --reply <text>", "Optional auto-reply text")
    .option("--path <path>", "Webhook path", "/webhook/whatsapp")
    .option(
      "--ingress <mode>",
      "Ingress: tailscale (funnel + Twilio update) | none (local only)",
      "tailscale",
    )
    .option("--verbose", "Log inbound and auto-replies", false)
    .option("-y, --yes", "Auto-confirm prompts when possible", false)
    .option("--dry-run", "Print planned actions without starting server", false)
    .addHelpText(
      "after",
      `
Examples:
  warelay webhook                       # ingress=tailscale (funnel + Twilio update)
  warelay webhook --ingress none        # local-only server (no funnel / no Twilio update)
  warelay webhook --port 45000          # pick a high, less-colliding port
  warelay webhook --reply "Got it!"     # static auto-reply; otherwise use config file`,
    )
    // istanbul ignore next
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      setYes(Boolean(opts.yes));
      const deps = createDefaultDeps();
      try {
        const server = await webhookCommand(opts, deps, defaultRuntime);
        if (!server) {
          defaultRuntime.log(
            info("Webhook dry-run complete; no server started."),
          );
          return;
        }
        process.on("SIGINT", () => {
          server.close(() => {
            console.log("\n👋 Webhook stopped");
            defaultRuntime.exit(0);
          });
        });
        await deps.waitForever();
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("relay:tmux")
    .description(
      "Run relay --verbose inside tmux (session warelay-relay), restarting if already running, then attach",
    )
    .action(async () => {
      try {
        const shouldAttach = Boolean(process.stdout.isTTY);
        const session = await spawnRelayTmux(
          "pnpm warelay relay --verbose",
          shouldAttach,
        );
        defaultRuntime.log(
          info(
            shouldAttach
              ? `tmux session started and attached: ${session} (pane running "pnpm warelay relay --verbose")`
              : `tmux session started: ${session} (pane running "pnpm warelay relay --verbose"); attach manually with "tmux attach -t ${session}"`,
          ),
        );
      } catch (err) {
        defaultRuntime.error(
          danger(`Failed to start relay tmux session: ${String(err)}`),
        );
        defaultRuntime.exit(1);
      }
    });

  program
    .command("relay:tmux:attach")
    .description(
      "Attach to the existing warelay-relay tmux session (no restart)",
    )
    .action(async () => {
      try {
        if (!process.stdout.isTTY) {
          defaultRuntime.error(
            danger(
              "Cannot attach: stdout is not a TTY. Run this in a terminal or use 'tmux attach -t warelay-relay' manually.",
            ),
          );
          defaultRuntime.exit(1);
          return;
        }
        await spawnRelayTmux("pnpm warelay relay --verbose", true, false);
        defaultRuntime.log(info("Attached to warelay-relay session."));
      } catch (err) {
        defaultRuntime.error(
          danger(`Failed to attach to warelay-relay: ${String(err)}`),
        );
        defaultRuntime.exit(1);
      }
    });

  program
    .command("relay:heartbeat:tmux")
    .description(
      "Run relay --verbose with an immediate heartbeat inside tmux (session warelay-relay), then attach",
    )
    .action(async () => {
      try {
        const shouldAttach = Boolean(process.stdout.isTTY);
        const session = await spawnRelayTmux(
          "pnpm warelay relay --verbose --heartbeat-now",
          shouldAttach,
        );
        defaultRuntime.log(
          info(
            shouldAttach
              ? `tmux session started and attached: ${session} (pane running "pnpm warelay relay --verbose --heartbeat-now")`
              : `tmux session started: ${session} (pane running "pnpm warelay relay --verbose --heartbeat-now"); attach manually with "tmux attach -t ${session}"`,
          ),
        );
      } catch (err) {
        defaultRuntime.error(
          danger(
            `Failed to start relay tmux session with heartbeat: ${String(err)}`,
          ),
        );
        defaultRuntime.exit(1);
      }
    });

  return program;
}
