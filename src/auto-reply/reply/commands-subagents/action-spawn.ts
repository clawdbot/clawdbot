import { spawnSubagentDirect } from "../../../agents/subagent-spawn.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { type SubagentsCommandContext, stopWithText } from "./shared.js";

export async function handleSubagentsSpawnAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { params, requesterKey, restTokens } = ctx;
  const requesterSessionEntry = params.sessionStore?.[requesterKey] ?? params.sessionEntry;
  const agentId = restTokens[0];

  const taskParts: string[] = [];
  let model: string | undefined;
  let thinking: string | undefined;
  for (let i = 1; i < restTokens.length; i++) {
    if (restTokens[i] === "--model" && i + 1 < restTokens.length) {
      i += 1;
      model = restTokens[i];
    } else if (restTokens[i] === "--thinking" && i + 1 < restTokens.length) {
      i += 1;
      thinking = restTokens[i];
    } else {
      taskParts.push(restTokens[i]);
    }
  }
  const task = taskParts.join(" ").trim();
  if (!agentId || !task) {
    return stopWithText(
      "Usage: /subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]",
    );
  }

  const commandTo = normalizeOptionalString(params.command.to) ?? "";
  const originatingTo = normalizeOptionalString(params.ctx.OriginatingTo) ?? "";
  const fallbackTo = normalizeOptionalString(params.ctx.To) ?? "";
  const normalizedTo = originatingTo || commandTo || fallbackTo || undefined;

  const result = await spawnSubagentDirect(
    {
      task,
      agentId,
      model,
      thinking,
      mode: "run",
      cleanup: "keep",
      expectsCompletionMessage: true,
    },
    {
      agentSessionKey: requesterKey,
      agentChannel: params.ctx.OriginatingChannel ?? params.command.channel,
      agentAccountId: params.ctx.AccountId,
      agentTo: normalizedTo,
      agentThreadId: params.ctx.MessageThreadId,
      agentGroupId: requesterSessionEntry?.groupId ?? null,
      agentGroupChannel: requesterSessionEntry?.groupChannel ?? null,
      agentGroupSpace: requesterSessionEntry?.space ?? null,
    },
  );
  if (result.status === "accepted") {
    return stopWithText(
      `Spawned subagent ${agentId} (session ${result.childSessionKey}, run ${result.runId?.slice(0, 8)}).`,
    );
  }
  return stopWithText(`Spawn failed: ${result.error ?? result.status}`);
}
