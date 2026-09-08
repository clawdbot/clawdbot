import { replyUnavailableComponentInteraction } from "./agent-components-context.js";
import type { AgentComponentContext, AgentComponentInteraction } from "./agent-components.types.js";
import { readDiscordInteractionPolicy } from "./live-policy-interaction.js";

export async function resolveAgentComponentPolicyContext(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
}): Promise<AgentComponentContext | null> {
  if (!params.ctx.readPolicy) {
    return params.ctx;
  }
  try {
    const policy = await readDiscordInteractionPolicy(params.ctx.readPolicy);
    if (!policy) {
      await replyUnavailableComponentInteraction(
        params.interaction,
        "Access policy is still updating. Try this interaction again.",
      );
      return null;
    }
    return { ...params.ctx, ...policy, isPolicyCurrent: policy.isCurrent, readPolicy: undefined };
  } catch (error) {
    await replyUnavailableComponentInteraction(
      params.interaction,
      "Could not verify the current access policy. Try this interaction again.",
    );
    throw error;
  }
}
