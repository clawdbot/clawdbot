import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { parseTimeoutMs } from "./parse-timeout.js";

export function registerTuiCli(program: Command) {
  program
    .command("tui")
    .alias("terminal")
    .alias("chat")
    .description("Open a terminal UI connected to the Gateway")
    .option("--local", "Run against the local embedded agent runtime", false)
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (if required)")
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
    .action(async (opts, cmd) => {
      try {
        // `cmd.name()` always returns the canonical subcommand name (`tui`).
        // Use the parsed parent args to see which alias the user actually typed.
        const invokedSubcommand = cmd.parent?.args[0];
        const invokedAsLocalAlias =
          invokedSubcommand === "terminal" || invokedSubcommand === "chat";
        const isLocal = Boolean(opts.local) || invokedAsLocalAlias;
        if (isLocal && (opts.url || opts.token || opts.password)) {
          throw new Error("--local cannot be combined with --url, --token, or --password");
        }
        const timeoutMs = parseTimeoutMs(opts.timeoutMs);
        if (opts.timeoutMs !== undefined && timeoutMs === undefined) {
          defaultRuntime.error(
            `warning: invalid --timeout-ms "${String(opts.timeoutMs)}"; ignoring`,
          );
        }
        const historyLimit = Number.parseInt(String(opts.historyLimit ?? "200"), 10);
        const { runTui } = await import("../tui/tui.js");
        await runTui({
          local: isLocal,
          url: opts.url as string | undefined,
          token: opts.token as string | undefined,
          password: opts.password as string | undefined,
          session: opts.session as string | undefined,
          deliver: Boolean(opts.deliver),
          thinking: opts.thinking as string | undefined,
          message: opts.message as string | undefined,
          timeoutMs,
          historyLimit: Number.isNaN(historyLimit) ? undefined : historyLimit,
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
