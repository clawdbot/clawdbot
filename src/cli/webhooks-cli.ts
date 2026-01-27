import type { Command } from "commander";

import { danger } from "../globals.js";
import {
  DEFAULT_GMAIL_LABEL,
  DEFAULT_GMAIL_MAX_BYTES,
  DEFAULT_GMAIL_RENEW_MINUTES,
  DEFAULT_GMAIL_SERVE_BIND,
  DEFAULT_GMAIL_SERVE_PATH,
  DEFAULT_GMAIL_SERVE_PORT,
  DEFAULT_GMAIL_SUBSCRIPTION,
  DEFAULT_GMAIL_TOPIC,
} from "../hooks/gmail.js";
import {
  type GmailRunOptions,
  type GmailSetupOptions,
  runGmailService,
  runGmailSetup,
} from "../hooks/gmail-ops.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

export function registerWebhooksCli(program: Command) {
  const webhooks = program
    .command("webhooks")
    .description("Webhook helpers and integrations")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/webhooks", "docs.molt.bot/cli/webhooks")}\n`,
    );

  const gmail = webhooks.command("gmail").description("Gmail Pub/Sub hooks (via gogcli)");

  gmail
    .command("setup")
    .description("Configure Gmail watch + Pub/Sub + Moltbot hooks")
    .requiredOption("--account <email>", "Gmail account to watch")
    .option("--project <id>", "GCP project id (OAuth client owner)")
    .option("--topic <name>", "Pub/Sub topic name", DEFAULT_GMAIL_TOPIC)
    .option("--subscription <name>", "Pub/Sub subscription name", DEFAULT_GMAIL_SUBSCRIPTION)
    .option("--label <label>", "Gmail label to watch", DEFAULT_GMAIL_LABEL)
    .option("--hook-url <url>", "Moltbot hook URL")
    .option("--hook-token <token>", "Moltbot hook token")
    .option("--push-token <token>", "Push token for gog watch serve")
    .option("--bind <host>", "gog watch serve bind host", DEFAULT_GMAIL_SERVE_BIND)
    .option("--port <port>", "gog watch serve port", String(DEFAULT_GMAIL_SERVE_PORT))
    .option("--path <path>", "gog watch serve path", DEFAULT_GMAIL_SERVE_PATH)
    .option("--include-body", "Include email body snippets", true)
    .option("--max-bytes <n>", "Max bytes for body snippets", String(DEFAULT_GMAIL_MAX_BYTES))
    .option(
      "--renew-minutes <n>",
      "Renew watch every N minutes",
      String(DEFAULT_GMAIL_RENEW_MINUTES),
    )
    .option("--tailscale <mode>", "Expose push endpoint via tailscale (funnel|serve|off)", "funnel")
    .option("--tailscale-path <path>", "Path for tailscale serve/funnel")
    .option(
      "--tailscale-target <target>",
      "Tailscale serve/funnel target (port, host:port, or URL)",
    )
    .option("--push-endpoint <url>", "Explicit Pub/Sub push endpoint")
    .option("--json", "Output JSON summary", false)
    .action(async (opts) => {
      try {
        const parsed = parseGmailSetupOptions(opts);
        await runGmailSetup(parsed);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  gmail
    .command("run")
    .description("Run gog watch serve + auto-renew loop")
    .option("--account <email>", "Gmail account to watch")
    .option("--topic <topic>", "Pub/Sub topic path (projects/.../topics/..)")
    .option("--subscription <name>", "Pub/Sub subscription name")
    .option("--label <label>", "Gmail label to watch")
    .option("--hook-url <url>", "Moltbot hook URL")
    .option("--hook-token <token>", "Moltbot hook token")
    .option("--push-token <token>", "Push token for gog watch serve")
    .option("--bind <host>", "gog watch serve bind host")
    .option("--port <port>", "gog watch serve port")
    .option("--path <path>", "gog watch serve path")
    .option("--include-body", "Include email body snippets")
    .option("--max-bytes <n>", "Max bytes for body snippets")
    .option("--renew-minutes <n>", "Renew watch every N minutes")
    .option("--tailscale <mode>", "Expose push endpoint via tailscale (funnel|serve|off)")
    .option("--tailscale-path <path>", "Path for tailscale serve/funnel")
    .option(
      "--tailscale-target <target>",
      "Tailscale serve/funnel target (port, host:port, or URL)",
    )
    .action(async (opts) => {
      try {
        const parsed = parseGmailRunOptions(opts);
        await runGmailService(parsed);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}

function parseGmailSetupOptions(raw: Record<string, unknown>): GmailSetupOptions {
  const accountRaw = raw.account;
  const account = typeof accountRaw === "string" ? accountRaw.trim() : "";
  if (!account) throw new Error("--account is required");
  return {
    account,
    project: stringOption(raw.project),
    topic: stringOption(raw.topic),
    subscription: stringOption(raw.subscription),
    label: stringOption(raw.label),
    hookUrl: stringOption(raw.hookUrl),
    hookToken: stringOption(raw.hookToken),
    pushToken: stringOption(raw.pushToken),
    bind: stringOption(raw.bind),
    port: numberOption(raw.port),
    path: stringOption(raw.path),
    includeBody: booleanOption(raw.includeBody),
    maxBytes: numberOption(raw.maxBytes),
    renewEveryMinutes: numberOption(raw.renewMinutes),
    tailscale: stringOption(raw.tailscale) as GmailSetupOptions["tailscale"],
    tailscalePath: stringOption(raw.tailscalePath),
    tailscaleTarget: stringOption(raw.tailscaleTarget),
    pushEndpoint: stringOption(raw.pushEndpoint),
    json: Boolean(raw.json),
  };
}

function parseGmailRunOptions(raw: Record<string, unknown>): GmailRunOptions {
  return {
    account: stringOption(raw.account),
    topic: stringOption(raw.topic),
    subscription: stringOption(raw.subscription),
    label: stringOption(raw.label),
    hookUrl: stringOption(raw.hookUrl),
    hookToken: stringOption(raw.hookToken),
    pushToken: stringOption(raw.pushToken),
    bind: stringOption(raw.bind),
    port: numberOption(raw.port),
    path: stringOption(raw.path),
    includeBody: booleanOption(raw.includeBody),
    maxBytes: numberOption(raw.maxBytes),
    renewEveryMinutes: numberOption(raw.renewMinutes),
    tailscale: stringOption(raw.tailscale) as GmailRunOptions["tailscale"],
    tailscalePath: stringOption(raw.tailscalePath),
    tailscaleTarget: stringOption(raw.tailscaleTarget),
  };
}

function stringOption(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function numberOption(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function booleanOption(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return Boolean(value);
}
