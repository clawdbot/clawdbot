import type { SystemAgentChatEngine } from "./chat-engine.js";

export function buildNewAgentWelcome(params: { engine: SystemAgentChatEngine }): string {
  const welcome =
    "Let's hatch a new agent. What should it be called, and what kind of work is it for? I'll use that context to settle its name, then propose creation for your approval. The new agent will learn its role during hatch.";
  params.engine.noteAssistantMessage(welcome);
  return welcome;
}
