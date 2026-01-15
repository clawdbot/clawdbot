import type { Command } from "commander";

import { sandboxListCommand, sandboxRecreateCommand } from "../commands/sandbox.js";
import { sandboxExplainCommand } from "../commands/sandbox-explain.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

// --- Types ---

type CommandOptions = Record<string, unknown>;

// --- Helpers ---

const EXAMPLES = {
  main: `
Examples:
  clawdbot sandbox list                     # List all sandbox containers
  clawdbot sandbox list --browser           # List only browser containers
  clawdbot sandbox recreate --all           # Recreate all containers
  clawdbot sandbox recreate --session main  # Recreate specific session
  clawdbot sandbox recreate --agent mybot   # Recreate agent containers
  clawdbot sandbox explain                  # Explain effective sandbox config`,

  list: `
Examples:
  clawdbot sandbox list              # List all sandbox containers
  clawdbot sandbox list --browser    # List only browser containers
  clawdbot sandbox list --json       # JSON output

Output includes:
  • Container name and status (running/stopped)
  • Docker image and whether it matches current config
  • Age (time since creation)
  • Idle time (time since last use)
  • Associated session/agent ID`,

  recreate: `
Examples:
  clawdbot sandbox recreate --all              # Recreate all containers
  clawdbot sandbox recreate --session main     # Specific session
  clawdbot sandbox recreate --agent mybot      # Specific agent (includes sub-agents)
  clawdbot sandbox recreate --browser --all    # All browser containers only
  clawdbot sandbox recreate --all --force      # Skip confirmation

Why use this?
  After updating Docker images or sandbox configuration, existing containers
  continue running with old settings. This command removes them so they'll be
  recreated automatically with current config when next needed.

Filter options:
  --all          Remove all sandbox containers
  --session      Remove container for specific session key
  --agent        Remove containers for agent (includes agent:id:* variants)
  
Modifiers:
  --browser      Only affect browser containers (not regular sandbox)
  --force        Skip confirmation prompt`,

  explain: `
Examples:
  clawdbot sandbox explain
  clawdbot sandbox explain --session agent:main:main
  clawdbot sandbox explain --agent work
  clawdbot sandbox explain --json`,
};

function createRunner(
  commandFn: (opts: CommandOptions, runtime: typeof defaultRuntime) => Promise<void>,
) {
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
    .addHelpText("after", EXAMPLES.main)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/sandbox", "docs.clawd.bot/cli/sandbox")}\n`,
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
    .addHelpText("after", EXAMPLES.list)
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
    .addHelpText("after", EXAMPLES.recreate)
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
    .addHelpText("after", EXAMPLES.explain)
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
