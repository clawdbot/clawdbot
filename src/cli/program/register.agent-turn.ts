// Single agent-turn command registration; delegates execution to the Gateway-backed agent command.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { formatHelpExamples } from "../help-format.js";

type AgentViaGatewayModule = typeof import("../../commands/agent-via-gateway.js");
type CliUtilsModule = typeof import("../cli-utils.js");
type GlobalStateModule = typeof import("../../global-state.js");
type RuntimeModule = typeof import("../../runtime.js");

async function loadAgentCliCommand(): Promise<AgentViaGatewayModule["agentCliCommand"]> {
  return (await import("../../commands/agent-via-gateway.js")).agentCliCommand;
}

async function loadDefaultRuntime(): Promise<RuntimeModule["defaultRuntime"]> {
  return (await import("../../runtime.js")).defaultRuntime;
}

async function loadRunCommandWithRuntime(): Promise<CliUtilsModule["runCommandWithRuntime"]> {
  return (await import("../cli-utils.js")).runCommandWithRuntime;
}

async function loadSetVerbose(): Promise<GlobalStateModule["setVerbose"]> {
  return (await import("../../global-state.js")).setVerbose;
}

/** Register `openclaw agent` for one Gateway-backed agent turn. */
export function registerAgentTurnCommand(
  program: Command,
  args: { agentChannelOptions: string },
): void {
  program
    .command("agent")
    .description("Run an agent turn via the Gateway (use --local for embedded)")
    .option("-m, --message <text>", "Message body for the agent")
    .option("--message-file <path>", "Read the agent message body from a UTF-8 file (max 4 MiB)")
    .option("-t, --to <number>", "Recipient number in E.164 used to derive the session key")
    .option("--session-key <key>", "Explicit session key (agent:<id>:<key>, or scoped to --agent)")
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
  ["openclaw agent --agent ops --message-file ./task.md", "Read a multiline message file."],
  [
    'openclaw agent --session-key agent:ops:incident-42 --message "Summarize status"',
    "Target an exact session key.",
  ],
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
      const [defaultRuntime, runCommandWithRuntime, setVerbose, agentCliCommand] =
        await Promise.all([
          loadDefaultRuntime(),
          loadRunCommandWithRuntime(),
          loadSetVerbose(),
          loadAgentCliCommand(),
        ]);
      await runCommandWithRuntime(defaultRuntime, async () => {
        setVerbose(verboseLevel === "on");
        await agentCliCommand(opts, defaultRuntime);
      });
    });
}
