// Status, health, sessions, and task/flow command registration.
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { setVerbose } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";
import { registerTasksCommand } from "./register.tasks.js";

function resolveVerbose(opts: { verbose?: boolean; debug?: boolean }): boolean {
  return Boolean(opts.verbose || opts.debug);
}

type SessionsListCliOptions = {
  json?: boolean;
  verbose?: boolean;
  store?: string;
  agent?: string;
  allAgents?: boolean;
  active?: string;
  limit?: string;
};

const SESSIONS_PARENT_OPTION_FLAGS = {
  json: "--json",
  verbose: "--verbose",
  store: "--store",
  agent: "--agent",
  allAgents: "--all-agents",
  active: "--active",
  limit: "--limit",
} satisfies Record<keyof SessionsListCliOptions, string>;

function rejectUnsupportedSessionsParentOptions(
  subcommand: string,
  parentOpts: SessionsListCliOptions | undefined,
  unsupportedOptions: readonly (keyof SessionsListCliOptions)[],
  reason: string,
): boolean {
  const unsupportedFlags = unsupportedOptions
    .filter((option) => {
      const value = parentOpts?.[option];
      return typeof value === "boolean" ? value : value !== undefined;
    })
    .map((option) => SESSIONS_PARENT_OPTION_FLAGS[option]);
  if (unsupportedFlags.length === 0) {
    return false;
  }
  const plural = unsupportedFlags.length > 1 ? "options" : "option";
  defaultRuntime.error(
    `\`sessions ${subcommand}\` does not support the parent \`sessions\` ${plural} ${unsupportedFlags.join(", ")}; ${reason}.`,
  );
  defaultRuntime.exit(1);
  return true;
}

function addSessionsListOptions(command: Command): Command {
  return command
    .option("--json", "Output as JSON", false)
    .option("--verbose", "Verbose logging", false)
    .option("--store <path>", "Path to physical .sqlite session store")
    .option("--agent <id>", "Agent id to inspect (required for multiple explicit agents)")
    .option("--all-agents", "Aggregate sessions across all configured agents", false)
    .option("--active <minutes>", "Only show sessions updated within the past N minutes")
    .option("--limit <count>", 'Max sessions to show (default: 100; use "all" for full output)');
}

function addSessionsGatewayOptions(command: Command): Command {
  return command
    .option("--agent <id>", "Agent id that owns the session (required for global keys)")
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "RPC timeout in milliseconds")
    .option("--json", "Output JSON", false);
}

function mergeSessionsListOptions(
  opts: SessionsListCliOptions,
  parentOpts?: SessionsListCliOptions,
): SessionsListCliOptions {
  return {
    json: Boolean(opts.json || parentOpts?.json),
    verbose: Boolean(opts.verbose || parentOpts?.verbose),
    store: opts.store ?? parentOpts?.store,
    agent: opts.agent ?? parentOpts?.agent,
    allAgents: Boolean(opts.allAgents || parentOpts?.allAgents),
    active: opts.active ?? parentOpts?.active,
    limit: opts.limit ?? parentOpts?.limit,
  };
}

async function runSessionsListCli(opts: SessionsListCliOptions): Promise<void> {
  setVerbose(Boolean(opts.verbose));
  const { sessionsCommand } = await import("../../commands/sessions.js");
  await sessionsCommand(
    {
      json: Boolean(opts.json),
      store: opts.store,
      agent: opts.agent,
      allAgents: Boolean(opts.allAgents),
      active: opts.active,
      limit: opts.limit,
    },
    defaultRuntime,
  );
}

function registerSessionsLifecycleCommand(
  sessionsCmd: Command,
  operation: "archive" | "delete",
): void {
  const destructive = operation === "delete";
  const examples: Array<[string, string]> = destructive
    ? [
        ['openclaw sessions delete "agent:main:scratch-1"', "Delete with confirmation."],
        [
          'openclaw sessions delete "agent:main:scratch-1" "agent:main:scratch-2" --yes',
          "Delete several sessions non-interactively.",
        ],
        [
          'openclaw sessions delete "agent:work:scratch-1" --agent work --dry-run',
          "Preview an agent-scoped delete.",
        ],
      ]
    : [
        ['openclaw sessions archive "agent:main:scratch-1"', "Archive one session."],
        [
          'openclaw sessions archive "agent:main:scratch-1" "agent:main:scratch-2"',
          "Archive several sessions.",
        ],
        [
          'openclaw sessions archive "agent:work:scratch-1" --agent work --dry-run',
          "Preview an agent-scoped archive.",
        ],
      ];
  const command = sessionsCmd
    .command(`${operation} <keys...>`)
    .description(
      destructive
        ? "Delete stored sessions and their live artifacts via the running gateway"
        : "Archive stored sessions via the running gateway",
    )
    .option(`--dry-run`, `Preview ${operation} actions without writing`, false);
  if (destructive) {
    command.option("--yes", "Skip the destructive confirmation prompt", false);
  }
  addSessionsGatewayOptions(command)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples(examples)}${
          destructive
            ? `\n\n${theme.muted(
                "Deletion uses the Control UI lifecycle operation, including transcript archival and runtime cleanup.",
              )}`
            : ""
        }`,
    )
    .action(async (keys: string[], opts, actionCommand) => {
      const parentOpts = actionCommand.parent?.opts() as SessionsListCliOptions | undefined;
      if (
        rejectUnsupportedSessionsParentOptions(
          operation,
          parentOpts,
          ["store", "allAgents", "active", "limit", "verbose"],
          "the gateway resolves target stores from each key and --agent",
        )
      ) {
        return;
      }
      const timeoutMs = parseStrictPositiveInteger(opts.timeout);
      if (opts.timeout !== undefined && timeoutMs === undefined) {
        defaultRuntime.error("--timeout must be a positive integer (milliseconds).");
        defaultRuntime.exit(1);
        return;
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        const lifecycleCommands = await import("../../commands/sessions-lifecycle.js");
        const handler = destructive
          ? lifecycleCommands.sessionsDeleteCommand
          : lifecycleCommands.sessionsArchiveCommand;
        await handler(
          {
            keys,
            agent: (opts.agent as string | undefined) ?? parentOpts?.agent,
            dryRun: Boolean(opts.dryRun),
            ...(destructive ? { yes: Boolean(opts.yes) } : {}),
            timeout: timeoutMs !== undefined ? String(timeoutMs) : undefined,
            url: opts.url as string | undefined,
            token: opts.token as string | undefined,
            password: opts.password as string | undefined,
            json: Boolean(opts.json || parentOpts?.json),
          },
          defaultRuntime,
        );
      });
    });
}

async function runWithVerboseAndTimeout(
  opts: { verbose?: boolean; debug?: boolean; timeout?: unknown },
  action: (params: { verbose: boolean; timeoutMs: number | undefined }) => Promise<void>,
): Promise<void> {
  const verbose = resolveVerbose(opts);
  setVerbose(verbose);
  await runCommandWithRuntime(defaultRuntime, async () => {
    const timeoutMs = parseStrictPositiveInteger(opts.timeout);
    if (opts.timeout !== undefined && timeoutMs === undefined) {
      throw new Error("--timeout must be a positive integer (milliseconds)");
    }
    await action({ verbose, timeoutMs });
  });
}

/** Register status/health plus persistent session/task inspection command groups. */
export function registerStatusHealthSessionsCommands(program: Command) {
  program
    .command("status")
    .description("Show channel health and recent session recipients")
    .option("--json", "Output JSON instead of text", false)
    .option("--all", "Full diagnosis (read-only, pasteable)", false)
    .option("--usage", "Show model provider usage/quota snapshots", false)
    .option("--agent <id>", "Agent id for --usage auth scope")
    .option("--deep", "Probe channels (WhatsApp Web + Telegram + Discord + Slack + Signal)", false)
    .option("--timeout <ms>", "Probe timeout in milliseconds", "10000")
    .option("--verbose", "Verbose logging", false)
    .option("--debug", "Alias for --verbose", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw status", "Show channel health + session summary."],
          ["openclaw status --all", "Full diagnosis (read-only)."],
          ["openclaw status --json", "Machine-readable output."],
          ["openclaw status --usage", "Show model provider usage/quota snapshots."],
          [
            "openclaw status --deep",
            "Run channel probes (WA + Telegram + Discord + Slack + Signal).",
          ],
          ["openclaw status --deep --timeout 5000", "Tighten probe timeout."],
        ])}`,
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/status", "docs.openclaw.ai/cli/status")}\n`,
    )
    .action(async (opts) => {
      await runWithVerboseAndTimeout(opts, async ({ verbose, timeoutMs }) => {
        const { statusCommand } = await import("../../commands/status.js");
        await statusCommand(
          {
            json: Boolean(opts.json),
            all: Boolean(opts.all),
            deep: Boolean(opts.deep),
            usage: Boolean(opts.usage),
            ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
            timeoutMs,
            verbose,
          },
          defaultRuntime,
        );
      });
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
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/health", "docs.openclaw.ai/cli/health")}\n`,
    )
    .action(async (opts) => {
      await runWithVerboseAndTimeout(opts, async ({ verbose, timeoutMs }) => {
        const { healthCommand } = await import("../../commands/health.js");
        await healthCommand(
          {
            json: Boolean(opts.json),
            timeoutMs,
            verbose,
          },
          defaultRuntime,
        );
      });
    });

  const sessionsCmd = addSessionsListOptions(
    program.command("sessions").description("List stored conversation sessions"),
  )
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw sessions", "List all sessions."],
          ["openclaw sessions --agent work", "List sessions for one agent."],
          ["openclaw sessions --all-agents", "Aggregate sessions across agents."],
          ["openclaw sessions --active 120", "Only last 2 hours."],
          ["openclaw sessions --limit 25", "Show the newest 25 sessions."],
          ["openclaw sessions --json", "Machine-readable output."],
          ["openclaw sessions --store ./tmp/sessions.sqlite", "Use a specific session store."],
        ])}\n\n${theme.muted(
          "Shows token usage per session when the agent reports it; set the model entry's contextTokens to cap the window and show %.",
        )}`,
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/sessions", "docs.openclaw.ai/cli/sessions")}\n`,
    )
    .action(async (opts) => {
      await runSessionsListCli(opts as SessionsListCliOptions);
    });
  sessionsCmd.enablePositionalOptions();

  addSessionsListOptions(
    sessionsCmd.command("list").description("List stored conversation sessions"),
  ).action(async (opts, command) => {
    const parentOpts = command.parent?.opts() as SessionsListCliOptions | undefined;
    await runSessionsListCli(mergeSessionsListOptions(opts as SessionsListCliOptions, parentOpts));
  });

  sessionsCmd
    .command("cleanup")
    .description("Run session-store maintenance now")
    .option("--store <path>", "Path to physical .sqlite session store")
    .option("--agent <id>", "Agent id to maintain (required for multiple explicit agents)")
    .option("--all-agents", "Run maintenance across all configured agents", false)
    .option("--dry-run", "Preview maintenance actions without writing", false)
    .option("--enforce", "Apply maintenance even when configured mode is warn", false)
    .option(
      "--fix-missing",
      "Remove store entries whose transcript files are missing (bypasses age/count retention)",
      false,
    )
    .option(
      "--fix-dm-scope",
      "Retire stale direct-DM session rows that no longer match session.dmScope=main",
      false,
    )
    .option("--active-key <key>", "Protect this session key from budget-eviction")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw sessions cleanup --dry-run", "Preview stale/cap cleanup."],
          [
            "openclaw sessions cleanup --dry-run --fix-missing",
            "Also preview pruning entries with missing transcript files.",
          ],
          [
            "openclaw sessions cleanup --dry-run --fix-dm-scope",
            "Preview stale direct-DM rows after returning dmScope to main.",
          ],
          ["openclaw sessions cleanup --enforce", "Apply maintenance now."],
          ["openclaw sessions cleanup --agent work --dry-run", "Preview one agent store."],
          ["openclaw sessions cleanup --all-agents --dry-run", "Preview all agent stores."],
          [
            "openclaw sessions cleanup --enforce --store ./tmp/sessions.sqlite",
            "Use a specific store.",
          ],
        ])}`,
    )
    .action(async (opts, command) => {
      const parentOpts = command.parent?.opts() as SessionsListCliOptions | undefined;
      if (
        rejectUnsupportedSessionsParentOptions(
          "cleanup",
          parentOpts,
          ["active", "limit", "verbose"],
          "session-list filters cannot scope session maintenance",
        )
      ) {
        return;
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { sessionsCleanupCommand } = await import("../../commands/sessions-cleanup.js");
        await sessionsCleanupCommand(
          {
            store: (opts.store as string | undefined) ?? parentOpts?.store,
            agent: (opts.agent as string | undefined) ?? parentOpts?.agent,
            allAgents: Boolean(opts.allAgents || parentOpts?.allAgents),
            dryRun: Boolean(opts.dryRun),
            enforce: Boolean(opts.enforce),
            fixMissing: Boolean(opts.fixMissing),
            fixDmScope: Boolean(opts.fixDmScope),
            activeKey: opts.activeKey as string | undefined,
            json: Boolean(opts.json || parentOpts?.json),
          },
          defaultRuntime,
        );
      });
    });

  sessionsCmd
    .command("tail")
    .description("Tail human-readable session trajectory progress")
    .option("--session-key <key>", "Session key to tail (default: active sessions or latest)")
    .option("--tail <count>", "Number of existing trajectory events to show", "80")
    .option("--follow", "Continue following for new trajectory events", false)
    .option("--store <path>", "Path to physical .sqlite session store")
    .option("--agent <id>", "Agent id to inspect (required for multiple explicit agents)")
    .option("--all-agents", "Aggregate sessions across all configured agents", false)
    .action(async (opts, command) => {
      const parentOpts = command.parent?.opts() as SessionsListCliOptions | undefined;
      if (
        rejectUnsupportedSessionsParentOptions(
          "tail",
          parentOpts,
          ["json", "active", "limit", "verbose"],
          "trajectory tail emits human-readable progress and selects sessions separately",
        )
      ) {
        return;
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { sessionsTailCommand } = await import("../../commands/sessions-tail.js");
        await sessionsTailCommand(
          {
            sessionKey: opts.sessionKey as string | undefined,
            store: (opts.store as string | undefined) ?? parentOpts?.store,
            agent: (opts.agent as string | undefined) ?? parentOpts?.agent,
            allAgents: Boolean(opts.allAgents || parentOpts?.allAgents),
            follow: Boolean(opts.follow),
            tail: opts.tail as string | undefined,
          },
          defaultRuntime,
        );
      });
    });

  sessionsCmd
    .command("export-trajectory")
    .description("Export a redacted trajectory bundle for a stored session")
    .option("--session-key <key>", "Session key to export")
    .option("--output <path>", "Output directory name inside .openclaw/trajectory-exports")
    .option("--workspace <path>", "Workspace root for the export (default: current directory)")
    .option("--store <path>", "Path to physical .sqlite session store")
    .option("--agent <id>", "Agent id for resolving the default session store")
    .option("--request-json-base64 <payload>", "Base64url-encoded export request")
    .option("--json", "Output JSON", false)
    .action(async (opts, command) => {
      const parentOpts = command.parent?.opts() as SessionsListCliOptions | undefined;
      if (
        rejectUnsupportedSessionsParentOptions(
          "export-trajectory",
          parentOpts,
          ["allAgents", "active", "limit", "verbose"],
          "trajectory export targets one session and cannot apply session-list filters",
        )
      ) {
        return;
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { exportTrajectoryCommand } = await import("../../commands/export-trajectory.js");
        await exportTrajectoryCommand(
          {
            sessionKey: opts.sessionKey as string | undefined,
            output: opts.output as string | undefined,
            workspace: opts.workspace as string | undefined,
            store: (opts.store as string | undefined) ?? parentOpts?.store,
            agent: (opts.agent as string | undefined) ?? parentOpts?.agent,
            requestJsonBase64: opts.requestJsonBase64 as string | undefined,
            json: Boolean(opts.json || parentOpts?.json),
          },
          defaultRuntime,
        );
      });
    });

  registerSessionsLifecycleCommand(sessionsCmd, "archive");
  registerSessionsLifecycleCommand(sessionsCmd, "delete");

  addSessionsGatewayOptions(sessionsCmd.command("compact <key>"))
    .description("Compact a stored session transcript via the running gateway")
    .option(
      "--max-lines <count>",
      "Truncate to the last N transcript lines instead of LLM summarization",
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            'openclaw sessions compact "agent:main:main"',
            "LLM-summarize a session to reclaim context budget.",
          ],
          [
            'openclaw sessions compact "agent:main:main" --max-lines 200',
            "Truncate to the last 200 transcript lines instead.",
          ],
          [
            'openclaw sessions compact "agent:work:main" --agent work --json',
            "Target one agent's session and emit JSON.",
          ],
        ])}\n\n${theme.muted(
          "Backed by the sessions.compact gateway RPC; exits non-zero when compaction fails.",
        )}`,
    )
    .action(async (key: string, opts, command) => {
      // Sibling `sessions` subcommands inherit parent options (see list/cleanup
      // above): `--agent`/`--json` may be supplied on the parent `sessions`
      // command, e.g. `openclaw sessions --agent work compact <key>`. Merge those
      // so a parent `--agent` is not silently dropped and the wrong agent's
      // session compacted.
      //
      // The parent also defines list-only options (`--store`/`--all-agents`/
      // `--active`/`--limit`). `compact` mutates the single session the gateway
      // resolves from <key> + --agent, so it cannot honor a parent `--store`
      // (the gateway picks the store) and the rest are meaningless here.
      // Silently dropping `--store` is the dangerous case — the user could
      // believe they targeted one store while the gateway compacts another — so
      // reject any unsupported inherited option instead of ignoring it.
      const parentOpts = command.parent?.opts() as SessionsListCliOptions | undefined;
      if (
        rejectUnsupportedSessionsParentOptions(
          "compact",
          parentOpts,
          ["store", "allAgents", "active", "limit", "verbose"],
          "the gateway resolves the target store from <key> and --agent",
        )
      ) {
        return;
      }
      const maxLines = parseStrictPositiveInteger(opts.maxLines);
      if (opts.maxLines !== undefined && maxLines === undefined) {
        defaultRuntime.error("--max-lines must be a positive integer.");
        defaultRuntime.exit(1);
        return;
      }
      const timeoutMs = parseStrictPositiveInteger(opts.timeout);
      if (opts.timeout !== undefined && timeoutMs === undefined) {
        defaultRuntime.error("--timeout must be a positive integer (milliseconds).");
        defaultRuntime.exit(1);
        return;
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { sessionsCompactCommand } = await import("../../commands/sessions-compact.js");
        await sessionsCompactCommand(
          {
            key,
            agent: (opts.agent as string | undefined) ?? parentOpts?.agent,
            maxLines,
            timeout: timeoutMs !== undefined ? String(timeoutMs) : undefined,
            url: opts.url as string | undefined,
            token: opts.token as string | undefined,
            password: opts.password as string | undefined,
            json: Boolean(opts.json || parentOpts?.json),
          },
          defaultRuntime,
        );
      });
    });

  registerTasksCommand(program);
}
