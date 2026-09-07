import { listAgentRoles, loadAgentRole } from "../agents/agent-roles.js";
import type { SystemAgentChatEngine } from "./chat-engine.js";

export async function buildNewAgentWelcome(params: {
  engine: Pick<SystemAgentChatEngine, "noteAssistantMessage">;
}): Promise<string> {
  const roles = await Promise.all(listAgentRoles().map(loadAgentRole));
  const choices = roles.map(({ manifest: { agent } }, index) => {
    if (!agent.name || !agent.description) {
      throw new Error(`Agent role "${agent.id}" requires a name and description.`);
    }
    return { title: agent.name, text: `${index + 1}. ${agent.name} — ${agent.description}` };
  });
  const welcome = [
    "Let's create an agent. Pick a role or describe your own; I'll propose creation for your approval.",
    ...choices.map(({ text }) => text),
    `5. A small team (${choices[0]!.title.toLowerCase()} plus the three specialists).`,
    "6. Something custom (tell me the name and the kind of work).",
  ].join("\n");
  params.engine.noteAssistantMessage(welcome);
  return welcome;
}
