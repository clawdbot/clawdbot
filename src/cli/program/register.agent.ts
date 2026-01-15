import type { Command } from "commander";
import { DEFAULT_CHAT_CHANNEL } from "../../channels/registry.js";
import { agentCliCommand } from "../../commands/agent-via-gateway.js";
import { agentsAddCommand, agentsDeleteCommand, agentsListCommand } from "../../commands/agents.js";
import { setVerbose } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { hasExplicitOptions } from "../command-options.js";
import { createDefaultDeps } from "../deps.js";
import { collectOption } from "./helpers.js";

export function registerAgentCommands(program: Command, args: { agentChannelOptions: string }) {
  program
    .command("agent")
    .description("Run an agent turn via the Gateway (use --local for embedded)")
    .requiredOption("-m, --message <text>", "Message body for the agent")
    .option("-t, --to <number>", "Recipient number in E.164 used to derive the session key")
    .option("--session-id <id>", "Use an explicit session id")
    .option("--thinking <level>", "Thinking level: off | minimal | low | medium | high")
    .option("--verbose <on|off>", "Persist agent verbose level for the session")
    .option(
      "--channel <channel>",
      `Delivery channel: ${args.agentChannelOptions} (default: ${DEFAULT_CHAT_CHANNEL})`,
    )
    .option(
      "--local",
      "Run the embedded agent locally (requires model provider API keys in your shell)",
      false,
    )
    .option(
      "--deliver",
      "Send the agent's reply back to the selected channel (requires --to)",
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

${theme.muted("Docs:")} ${formatDocsLink("/cli/agent", "docs.clawd.bot/cli/agent")}`,
    )
    .action(async (opts) => {
      const verboseLevel = typeof opts.verbose === "string" ? opts.verbose.toLowerCase() : "";
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
    .description("Manage isolated agents (workspaces + auth + routing)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/agents", "docs.clawd.bot/cli/agents")}\n`,
    );

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
    .option("--bind <channel[:accountId]>", "Route channel binding (repeatable)", collectOption, [])
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
            bind: Array.isArray(opts.bind) ? (opts.bind as string[]) : undefined,
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
}
