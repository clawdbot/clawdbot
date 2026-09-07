import { createAgentTeam } from "../agents/agent-team.js";
import { formatCliCommand } from "../cli/command-format.js";
import { ExpectedCliError } from "../cli/failure-output.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { shortenHomePath } from "../utils.js";

type AgentsTeamCreateOptions = {
  preset?: string;
  coordinator?: string;
  prefix?: string;
  workspaceRoot?: string;
  nonInteractive?: boolean;
  json?: boolean;
};

export async function agentsTeamCreateCommand(
  opts: AgentsTeamCreateOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const result = await createAgentTeam(opts);
  if (result.status === "error") {
    throw new ExpectedCliError({
      message: result.message,
      humanOutput: result.message,
      machineOutput: result.message,
    });
  }
  const note =
    result.ambientOwnerId !== result.coordinatorId
      ? `ambient owner stays ${result.ambientOwnerId}; talk to the coordinator by name`
      : undefined;
  const agents = result.agents.map(({ agentId, name, workspace, agentDir }) => ({
    agentId,
    name,
    workspace,
    agentDir,
  }));
  if (opts.json) {
    writeRuntimeJson(runtime, {
      coordinatorId: result.coordinatorId,
      agents,
      ambientOwnerId: result.ambientOwnerId,
      ...(note ? { note } : {}),
    });
    return;
  }
  runtime.log(`Created team with coordinator "${result.coordinatorId}":`);
  for (const agent of agents) {
    runtime.log(`- ${agent.agentId}: ${shortenHomePath(agent.workspace)}`);
  }
  if (note) {
    runtime.log(note);
  }
  runtime.log(
    `Talk to the coordinator: ${formatCliCommand(`openclaw agent --agent ${result.coordinatorId} --message "Describe your task"`)}`,
  );
}
