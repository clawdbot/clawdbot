import type { AgentComponentInteraction } from "./agent-components.types.js";

export async function replySilently(
  interaction: AgentComponentInteraction,
  params: { content: string; ephemeral?: boolean },
) {
  try {
    await interaction.reply(params);
  } catch {}
}
