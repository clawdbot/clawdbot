// Commander registration for sandbox container list, recreate, and explain commands.
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { sandboxExplainCommand } from "../commands/sandbox-explain.js";
import { sandboxListCommand, sandboxRecreateCommand } from "../commands/sandbox.js";
import { defaultRuntime } from "../runtime.js";
import { formatHelpExamples } from "./help-format.js";

// --- Types ---

type CommandOptions = Record<string, unknown>;

// --- Helpers ---

const SANDBOX_EXAMPLES = {
  main: [
    ["openclaw sandbox list", "List all sandbox containers."],
    ["openclaw sandbox list --browser", "List only browser containers."],
    ["openclaw sandbox recreate --all", "Recreate all containers."],
    ["openclaw sandbox recreate --session main", "Recreate a specific session."],
    ["openclaw sandbox recreate --agent mybot", "Recreate agent containers."],
    ["openclaw sandbox explain", "Explain effective sandbox config."],
  ],
  list: [
    ["openclaw sandbox list", "List all sandbox containers."],
    ["openclaw sandbox list --browser", "List only browser containers."],
    ["openclaw sandbox list --json", "JSON output."],
  ],
  recreate: [
    ["openclaw sandbox recreate --all", "Recreate all containers."],
    ["openclaw sandbox recreate --session main", "Recreate a specific session."],
    ["openclaw sandbox recreate --agent mybot", "Recreate a specific agent (includes sub-agents)."],
    ["openclaw sandbox recreate --browser --all", "Recreate only browser containers."],
    ["openclaw sandbox recreate --all --force", "Skip confirmation."],
  ],
  explain: [
    ["openclaw sandbox explain", "Show effective sandbox config."],
    ["openclaw sandbox explain --session agent:main:main", "Explain a specific session."],
    ["openclaw sandbox explain --agent work", "Explain an agent sandbox."],
    ["openclaw sandbox explain --json", "JSON output."],
  ],
} as const;

function createRunner(
  commandFn: (opts: CommandOptions, runtime: typeof defaultRuntime) => Promise<void>,
) {
  // Sandbox commands share the default runtime error/exit behavior.
  return async (opts: CommandOptions) => {
    try {
      await commandFn(opts, defaultRuntime);
    } catch (err) {
      defaultRuntime.error(String(err));
      defaultRuntime.exit(1);
    }
  };
}

// --- Registration ---

export function registerSandboxCli(program: Command) {
  const sandbox = program
    .command("sandbox")
    .description("Manage sandbox containers (Docker-based agent isolation)")
    .addHelpText(
      "after",
      () => `\n${theme.heading("Examples:")}\n${formatHelpExamples(SANDBOX_EXAMPLES.main)}\n`,
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/sandbox", "docs.openclaw.ai/cli/sandbox")}\n`,
    )
    .action(() => {
      sandbox.help({ error: true });
    });

  // --- List Command ---

  sandbox
    .command("list")
    .description("List sandbox containers and their status")
    .option("--json", "Output result as JSON", false)
    .option("--browser", "List browser containers only", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples(SANDBOX_EXAMPLES.list)}\n\n${theme.heading(
          "Output includes:",
        )}\n${theme.muted("- Container name and status (running/stopped)")}\n${theme.muted(
          "- Docker image and whether it matches current config",
        )}\n${theme.muted("- Age (time since creation)")}\n${theme.muted(
          "- Idle time (time since last use)",
        )}\n${theme.muted("- Associated session/agent ID")}`,
    )
    .action(
      createRunner((opts) =>
        sandboxListCommand(
          {
            browser: Boolean(opts.browser),
            json: Boolean(opts.json),
          },
          defaultRuntime,
        ),
      ),
    );

  // --- Recreate Command ---

  sandbox
    .command("recreate")
    .description("Remove containers to force recreation with updated config")
    .option("--all", "Recreate all sandbox containers", false)
    .option("--session <key>", "Recreate container for specific session")
    .option("--agent <id>", "Recreate containers for specific agent")
    .option("--browser", "Only recreate browser containers", false)
    .option("--force", "Skip confirmation prompt", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples(SANDBOX_EXAMPLES.recreate)}\n\n${theme.heading(
          "Why use this?",
        )}\n${theme.muted(
          "After updating Docker images or sandbox configuration, existing containers continue running with old settings.",
        )}\n${theme.muted(
          "This command removes them so they'll be recreated automatically with current config when next needed.",
        )}\n\n${theme.heading("Filter options:")}\n${theme.muted(
          "  --all          Remove all sandbox containers",
        )}\n${theme.muted(
          "  --session      Remove container for specific session key",
        )}\n${theme.muted(
          "  --agent        Remove containers for agent (includes agent:id:* variants)",
        )}\n\n${theme.heading("Modifiers:")}\n${theme.muted(
          "  --browser      Only affect browser containers (not regular sandbox)",
        )}\n${theme.muted("  --force        Skip confirmation prompt")}`,
    )
    .action(
      createRunner((opts) =>
        sandboxRecreateCommand(
          {
            all: Boolean(opts.all),
            session: opts.session as string | undefined,
            agent: opts.agent as string | undefined,
            browser: Boolean(opts.browser),
            force: Boolean(opts.force),
          },
          defaultRuntime,
        ),
      ),
    );

  // --- Explain Command ---

  sandbox
    .command("explain")
    .description("Explain effective sandbox/tool policy for a session/agent")
    .option("--session <key>", "Session key to inspect (defaults to agent main)")
    .option("--agent <id>", "Agent id to inspect (defaults to derived agent)")
    .option("--json", "Output result as JSON", false)
    .addHelpText(
      "after",
      () => `\n${theme.heading("Examples:")}\n${formatHelpExamples(SANDBOX_EXAMPLES.explain)}\n`,
    )
    .action(
      createRunner((opts) =>
        sandboxExplainCommand(
          {
            session: opts.session as string | undefined,
            agent: opts.agent as string | undefined,
            json: Boolean(opts.json),
          },
          defaultRuntime,
        ),
      ),
    );
}
