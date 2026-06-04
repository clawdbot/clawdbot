// Agent and agents command registration with lazy command-module loading for startup speed.
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { hasExplicitOptions } from "../command-options.js";
import { formatHelpExamples } from "../help-format.js";
import { collectOption } from "./helpers.js";
import { registerAgentTurnCommand } from "./register.agent-turn.js";

type AgentsAddModule = typeof import("../../commands/agents.commands.add.js");
type AgentsBindModule = typeof import("../../commands/agents.commands.bind.js");
type AgentsDeleteModule = typeof import("../../commands/agents.commands.delete.js");
type AgentsIdentityModule = typeof import("../../commands/agents.commands.identity.js");
type AgentsListModule = typeof import("../../commands/agents.commands.list.js");
type CliUtilsModule = typeof import("../cli-utils.js");
type RuntimeModule = typeof import("../../runtime.js");

let agentsBindModulePromise: Promise<AgentsBindModule> | undefined;

function loadAgentsBindModule(): Promise<AgentsBindModule> {
  return (agentsBindModulePromise ??= import("../../commands/agents.commands.bind.js"));
}

async function loadAgentsAddCommand(): Promise<AgentsAddModule["agentsAddCommand"]> {
  return (await import("../../commands/agents.commands.add.js")).agentsAddCommand;
}

async function loadAgentsBindCommand(): Promise<AgentsBindModule["agentsBindCommand"]> {
  return (await loadAgentsBindModule()).agentsBindCommand;
}

async function loadAgentsBindingsCommand(): Promise<AgentsBindModule["agentsBindingsCommand"]> {
  return (await loadAgentsBindModule()).agentsBindingsCommand;
}

async function loadAgentsUnbindCommand(): Promise<AgentsBindModule["agentsUnbindCommand"]> {
  return (await loadAgentsBindModule()).agentsUnbindCommand;
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

async function loadAgentsActionRuntime(): Promise<{
  defaultRuntime: RuntimeModule["defaultRuntime"];
  runCommandWithRuntime: CliUtilsModule["runCommandWithRuntime"];
}> {
  const [{ defaultRuntime }, { runCommandWithRuntime }] = await Promise.all([
    import("../../runtime.js"),
    import("../cli-utils.js"),
  ]);
  return { defaultRuntime, runCommandWithRuntime };
}

async function runAgentsCommandAction(
  action: (runtime: RuntimeModule["defaultRuntime"]) => Promise<void>,
): Promise<void> {
  const { defaultRuntime, runCommandWithRuntime } = await loadAgentsActionRuntime();
  await runCommandWithRuntime(defaultRuntime, async () => {
    await action(defaultRuntime);
  });
}

/** Register single-turn `agent` plus multi-agent management commands. */
export function registerAgentCommands(
  program: Command,
  args: { agentChannelOptions: string },
): void {
  registerAgentTurnCommand(program, args);
  registerAgentsCommands(program);
}

/** Register `agents` management subcommands for config, bindings, identity, and deletion. */
export function registerAgentsCommands(program: Command): void {
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
      await runAgentsCommandAction(async (runtime) => {
        const agentsListCommand = await loadAgentsListCommand();
        await agentsListCommand(
          { json: Boolean(opts.json), bindings: Boolean(opts.bindings) },
          runtime,
        );
      });
    });

  agents
    .command("bindings")
    .description("List routing bindings")
    .option("--agent <id>", "Filter by agent id")
    .option("--json", "Output JSON instead of text", false)
    .action(async (opts): Promise<void> => {
      await runAgentsCommandAction(async (runtime) => {
        const agentsBindingsCommand = await loadAgentsBindingsCommand();
        await agentsBindingsCommand(
          {
            agent: opts.agent as string | undefined,
            json: Boolean(opts.json),
          },
          runtime,
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
      await runAgentsCommandAction(async (runtime) => {
        const agentsBindCommand = await loadAgentsBindCommand();
        await agentsBindCommand(
          {
            agent: opts.agent as string | undefined,
            bind: Array.isArray(opts.bind) ? (opts.bind as string[]) : undefined,
            json: Boolean(opts.json),
          },
          runtime,
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
      await runAgentsCommandAction(async (runtime) => {
        const agentsUnbindCommand = await loadAgentsUnbindCommand();
        await agentsUnbindCommand(
          {
            agent: opts.agent as string | undefined,
            bind: Array.isArray(opts.bind) ? (opts.bind as string[]) : undefined,
            all: Boolean(opts.all),
            json: Boolean(opts.json),
          },
          runtime,
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
      await runAgentsCommandAction(async (runtime) => {
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
          runtime,
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
      await runAgentsCommandAction(async (runtime) => {
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
          runtime,
        );
      });
    });

  agents
    .command("delete <id>")
    .description("Delete an agent and prune workspace/state")
    .option("--force", "Skip confirmation", false)
    .option("--json", "Output JSON summary", false)
    .action(async (id, opts): Promise<void> => {
      await runAgentsCommandAction(async (runtime) => {
        const agentsDeleteCommand = await loadAgentsDeleteCommand();
        await agentsDeleteCommand(
          {
            id: String(id),
            force: Boolean(opts.force),
            json: Boolean(opts.json),
          },
          runtime,
        );
      });
    });

  agents.action(async (): Promise<void> => {
    await runAgentsCommandAction(async (runtime) => {
      const agentsListCommand = await loadAgentsListCommand();
      await agentsListCommand({}, runtime);
    });
  });
}
