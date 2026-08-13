import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
// Registers the terminal UI subcommand and normalizes its local-vs-gateway options.
import type { Command } from "commander";
import { CHAT_HISTORY_MAX_ENTRIES } from "../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../runtime.js";
import { parseTimeoutMs } from "./parse-timeout.js";
import { resolveSessionTarget } from "./session-target.js";
import { addTuiOptions } from "./tui-cli-options.js";

type TuiCliOptions = {
  local?: boolean;
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  session?: string;
  deliver?: boolean;
  thinking?: string;
  message?: string;
  timeoutMs?: string;
  historyLimit?: string;
};

export async function runTuiCliAction(
  target: string | undefined,
  opts: TuiCliOptions,
  invokedSubcommand = "tui",
): Promise<void> {
  const invokedAsLocalAlias = invokedSubcommand === "terminal" || invokedSubcommand === "chat";
  const isLocal = Boolean(opts.local) || invokedAsLocalAlias;
  if (target && isLocal) {
    throw new Error(
      "a session target cannot be combined with --local, openclaw chat, or openclaw terminal",
    );
  }
  if (isLocal && (opts.url || opts.token || opts.password || opts.tlsFingerprint)) {
    throw new Error(
      "--local cannot be combined with --url, --token, --password, or --tls-fingerprint",
    );
  }
  if (target && opts.session) {
    throw new Error("pass one session target: use either the positional target or --session");
  }
  const timeoutMs = parseTimeoutMs(opts.timeoutMs);
  if (opts.timeoutMs !== undefined && timeoutMs === undefined) {
    defaultRuntime.error(`warning: invalid --timeout-ms "${opts.timeoutMs}"; ignoring`);
  }
  const historyLimit = parseStrictPositiveInteger(opts.historyLimit ?? "200");
  if (historyLimit === undefined) {
    throw new Error("--history-limit must be a positive integer.");
  }
  if (!isLocal && historyLimit > CHAT_HISTORY_MAX_ENTRIES) {
    throw new Error(`--history-limit must be at most ${CHAT_HISTORY_MAX_ENTRIES}.`);
  }

  const resolved = target
    ? await resolveSessionTarget({
        raw: target,
        requiredScope: "operator.admin",
        gateway: {
          url: opts.url,
          token: opts.token,
          password: opts.password,
          tlsFingerprint: opts.tlsFingerprint,
        },
      })
    : undefined;
  const { runTui } = await import("../tui/tui.js");
  await runTui({
    local: isLocal,
    ...(resolved?.gateway.url
      ? {
          boundGateway: {
            url: resolved.gateway.url,
            token: resolved.gateway.token,
            password: resolved.gateway.password,
            tlsFingerprint: resolved.gateway.tlsFingerprint,
          },
        }
      : {
          url: opts.url,
          token: opts.token,
          password: opts.password,
          tlsFingerprint: opts.tlsFingerprint,
        }),
    session: resolved?.sessionKey ?? opts.session,
    ...(resolved?.parsed.kind === "url" ? { agentId: resolved.parsed.agentId } : {}),
    deliver: Boolean(opts.deliver),
    thinking: opts.thinking,
    message: opts.message,
    timeoutMs,
    historyLimit,
    forceProcessExitOnReturn: true,
  });
}

/** Attach the `tui` command plus its `terminal`/`chat` aliases to the root CLI. */
export function registerTuiCli(program: Command) {
  const command = program
    .command("tui")
    .alias("terminal")
    .alias("chat")
    .description("Open a terminal UI connected to the Gateway")
    .argument("[target]", "Control UI URL, host/agent/ref, short ref, or agent:... key")
    .option("--local", "Run against the local embedded agent runtime", false);
  addTuiOptions(command)
    .option("--session <key>", 'Session key (default: "main", or "global" when scope is global)')
    .option("--deliver", "Deliver assistant replies", false)
    .option("--thinking <level>", "Thinking level override")
    .option("--message <text>", "Send an initial message after connecting")
    .option("--timeout-ms <ms>", "Agent timeout in ms (defaults to agents.defaults.timeoutSeconds)")
    .option("--history-limit <n>", "History entries to load", "200")
    .addHelpText(
      "after",
      () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/tui", "docs.openclaw.ai/cli/tui")}\n`,
    )
    .action(async (target: string | undefined, opts: TuiCliOptions, cmd: Command) => {
      try {
        // `cmd.name()` always returns the canonical subcommand name (`tui`).
        // Use the parsed parent args to see which alias the user actually typed.
        const invokedSubcommand = cmd.parent?.args[0];
        await runTuiCliAction(target, opts, invokedSubcommand);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
