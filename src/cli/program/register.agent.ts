import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { hasExplicitOptions } from "../command-options.js";
import { formatHelpExamples } from "../help-format.js";
import { collectOption } from "./helpers.js";

type AgentViaGatewayModule = typeof import("../../commands/agent-via-gateway.js");
type AgentsAddModule = typeof import("../../commands/agents.commands.add.js");
type AgentsBindModule = typeof import("../../commands/agents.commands.bind.js");
type AgentsDeleteModule = typeof import("../../commands/agents.commands.delete.js");
type AgentsIdentityModule = typeof import("../../commands/agents.commands.identity.js");
type AgentsListModule = typeof import("../../commands/agents.commands.list.js");
type CliDepsModule = typeof import("../deps.js");
type GlobalStateModule = typeof import("../../global-state.js");

async function loadAgentCliCommand(): Promise<AgentViaGatewayModule["agentCliCommand"]> {
  return (await import("../../commands/agent-via-gateway.js")).agentCliCommand;
}

async function loadAgentsAddCommand(): Promise<AgentsAddModule["agentsAddCommand"]> {
  return (await import("../../commands/agents.commands.add.js")).agentsAddCommand;
}

async function loadAgentsBindCommand(): Promise<AgentsBindModule["agentsBindCommand"]> {
  return (await import("../../commands/agents.commands.bind.js")).agentsBindCommand;
}

async function loadAgentsBindingsCommand(): Promise<AgentsBindModule["agentsBindingsCommand"]> {
  return (await import("../../commands/agents.commands.bind.js")).agentsBindingsCommand;
}

async function loadAgentsUnbindCommand(): Promise<AgentsBindModule["agentsUnbindCommand"]> {
  return (await import("../../commands/agents.commands.bind.js")).agentsUnbindCommand;
}

async function loadAgentsDeleteCommand(): Promise<AgentsDeleteModule["agentsDeleteCommand"]> {
  return (await import("../../commands/agents.commands.delete.js")).agentsDeleteCommand;
}

async function loadAgentsSetIdentityCommand(): Promise<
  AgentsIdentityModule["agentsSetIdentityCommand"]
> {
  return (await import("../../commands/agents.commands.identity.js")).agentsSetIdentityCommand;
}

async function loadAgentsListCommand(): Promise<AgentsListModule["agentsListCommand"]> {
  return (await import("../../commands/agents.commands.list.js")).agentsListCommand;
}

async function loadCreateDefaultDeps(): Promise<CliDepsModule["createDefaultDeps"]> {
  return (await import("../deps.js")).createDefaultDeps;
}

async function loadSetVerbose(): Promise<GlobalStateModule["setVerbose"]> {
  return (await import("../../global-state.js")).setVerbose;
}

export function registerAgentCommands(
  program: Command,
  args: { agentChannelOptions: string },
): void {
  program
    .command("agent")
    .description("Run an agent turn via the Gateway (use --local for embedded)")
    .requiredOption("-m, --message <text>", "Message body for the agent")
    .option("-t, --to <number>", "Recipient number in E.164 used to derive the session key")
    .option("--session-id <id>", "Use an explicit session id")
    .option("--agent <id>", "Agent id (overrides routing bindings)")
    .option("--model <id>", "Model override for this run (provider/model or model id)")
    .option(
      "--thinking <level>",
      "Thinking level: off | minimal | low | medium | high | xhigh | adaptive | max where supported",
    )
    .option("--verbose <on|off>", "Persist agent verbose level for the session")
    .option(
      "--channel <channel>",
      `Delivery channel: ${args.agentChannelOptions} (omit to use the main session channel)`,
    )
    .option("--reply-to <target>", "Delivery target override (separate from session routing)")
    .option("--reply-channel <channel>", "Delivery channel override (separate from routing)")
    .option("--reply-account <id>", "Delivery account id override")
    .option(
      "--local",
      "Run the embedded agent locally (requires model provider API keys in your shell)",
      false,
    )
    .option("--deliver", "Send the agent's reply back to the selected channel", false)
    .option("--json", "Output result as JSON", false)
    .option(
      "--timeout <seconds>",
      "Override agent command timeout (seconds, default 600 or config value)",
    )
    .addHelpText(
      "after",
      () =>
        `
${theme.heading("Examples:")}
${formatHelpExamples([
  ['openclaw agent --to +15555550123 --message "status update"', "Start a new session."],
  ['openclaw agent --agent ops --message "Summarize logs"', "Use a specific agent."],
  [
    'openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium',
    "Target a session with explicit thinking level.",
  ],
  [
    'openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json',
    "Enable verbose logging and JSON output.",
  ],
  ['openclaw agent --to +15555550123 --message "Summon reply" --deliver', "Deliver reply."],
  [
    'openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"',
    "Send reply to a different channel/target.",
  ],
])}

${theme.muted("Docs:")} ${formatDocsLink("/cli/agent", "docs.openclaw.ai/cli/agent")}`,
    )
    .action(async (opts): Promise<void> => {
      const verboseLevel =
        typeof opts.verbose === "string" ? normalizeLowercaseStringOrEmpty(opts.verbose) : "";
      await runCommandWithRuntime(defaultRuntime, async () => {
        const setVerbose = await loadSetVerbose();
        setVerbose(verboseLevel === "on");
        // Build default deps (keeps parity with other commands; future-proofing).
        const createDefaultDeps = await loadCreateDefaultDeps();
        const deps = createDefaultDeps();
        const agentCliCommand = await loadAgentCliCommand();
        await agentCliCommand(opts, defaultRuntime, deps);
      });
    });

  const agents = program
    .command("agents")
    .description("Manage isolated agents (workspaces + auth + routing)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/agents", "docs.openclaw.ai/cli/agents")}\n`,
    );

  agents
    .command("list")
    .description("List configured agents")
    .option("--json", "Output JSON instead of text", false)
    .option("--bindings", "Include routing bindings", false)
    .action(async (opts): Promise<void> => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const agentsListCommand = await loadAgentsListCommand();
        await agentsListCommand(
          { json: Boolean(opts.json), bindings: Boolean(opts.bindings) },
          defaultRuntime,
        );
      });
    });

  agents
    .command("bindings")
    .description("List routing bindings")
    .option("--agent <id>", "Filter by agent id")
    .option("--json", "Output JSON instead of text", false)
    .action(async (opts): Promise<void> => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const agentsBindingsCommand = await loadAgentsBindingsCommand();
        await agentsBindingsCommand(
          {
            agent: opts.agent as string | undefined,
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });

  agents
    .command("bind")
    .description("Add routing bindings for an agent")
    .option("--agent <id>", "Agent id (defaults to current default agent)")
    .option(
      "--bind <channel[:accountId]>",
      "Binding to add (repeatable). If omitted, accountId is resolved by channel defaults/hooks.",
      collectOption,
      [],
    )
    .option("--json", "Output JSON summary", false)
    .action(async (opts): Promise<void> => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const agentsBindCommand = await loadAgentsBindCommand();
        await agentsBindCommand(
          {
            agent: opts.agent as string | undefined,
            bind: Array.isArray(opts.bind) ? (opts.bind as string[]) : undefined,
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });

  agents
    .command("unbind")
    .description("Remove routing bindings for an agent")
    .option("--agent <id>", "Agent id (defaults to current default agent)")
    .option("--bind <channel[:accountId]>", "Binding to remove (repeatable)", collectOption, [])
    .option("--all", "Remove all bindings for this agent", false)
    .option("--json", "Output JSON summary", false)
    .action(async (opts): Promise<void> => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const agentsUnbindCommand = await loadAgentsUnbindCommand();
        await agentsUnbindCommand(
          {
            agent: opts.agent as string | undefined,
            bind: Array.isArray(opts.bind) ? (opts.bind as string[]) : undefined,
            all: Boolean(opts.all),
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
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
    .action(async (name, opts, command): Promise<void> => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const hasFlags = hasExplicitOptions(command, [
          "workspace",
          "model",
          "agentDir",
          "bind",
          "nonInteractive",
        ]);
        const agentsAddCommand = await loadAgentsAddCommand();
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
      });
    });

  agents
    .command("set-identity")
    .description("Update an agent identity (name/theme/emoji/avatar)")
    .option("--agent <id>", "Agent id to update")
    .option("--workspace <dir>", "Workspace directory used to locate the agent + IDENTITY.md")
    .option("--identity-file <path>", "Explicit IDENTITY.md path to read")
    .option("--from-identity", "Read values from IDENTITY.md", false)
    .option("--name <name>", "Identity name")
    .option("--theme <theme>", "Identity theme")
    .option("--emoji <emoji>", "Identity emoji")
    .option("--avatar <value>", "Identity avatar (workspace path, http(s) URL, or data URI)")
    .option("--json", "Output JSON summary", false)
    .addHelpText(
      "after",
      () =>
        `
${theme.heading("Examples:")}
${formatHelpExamples([
  ['openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞"', "Set name + emoji."],
  ["openclaw agents set-identity --agent main --avatar avatars/openclaw.png", "Set avatar path."],
  [
    "openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity",
    "Load from IDENTITY.md.",
  ],
  [
    "openclaw agents set-identity --identity-file ~/.openclaw/workspace/IDENTITY.md --agent main",
    "Use a specific IDENTITY.md.",
  ],
])}
`,
    )
    .action(async (opts): Promise<void> => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const agentsSetIdentityCommand = await loadAgentsSetIdentityCommand();
        await agentsSetIdentityCommand(
          {
            agent: opts.agent as string | undefined,
            workspace: opts.workspace as string | undefined,
            identityFile: opts.identityFile as string | undefined,
            fromIdentity: Boolean(opts.fromIdentity),
            name: opts.name as string | undefined,
            theme: opts.theme as string | undefined,
            emoji: opts.emoji as string | undefined,
            avatar: opts.avatar as string | undefined,
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });

  agents
    .command("delete <id>")
    .description("Delete an agent and prune workspace/state")
    .option("--force", "Skip confirmation", false)
    .option("--json", "Output JSON summary", false)
    .action(async (id, opts): Promise<void> => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const agentsDeleteCommand = await loadAgentsDeleteCommand();
        await agentsDeleteCommand(
          {
            id: String(id),
            force: Boolean(opts.force),
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });

  agents.action(async (): Promise<void> => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      const agentsListCommand = await loadAgentsListCommand();
      await agentsListCommand({}, defaultRuntime);
    });
  });
}
