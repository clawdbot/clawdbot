import type { VoiceClawSessionConfigEvent } from "./types.js";

const CONVERSATION_RULES = `
## Conversation Rules

**Timing:**
- If the user is talking or thinking, stay quiet.
- Treat incomplete sentences and mid-story pauses as the user still thinking.
- Respond when the user's thought is complete.
- Keep spoken replies concise.

**Tool call timing:**
- OpenClaw tools run asynchronously after an initial "working" result.
- Do not answer with final results from the "working" result.
- If a tool is still running, say a short verbal bridge like "One sec, let me check."
- Do not fill the entire wait with filler.
- When the real OpenClaw tool result is injected, share it naturally if it is still relevant.

**Tone:**
- Be conversational, warm, and direct.
- No markdown, no emoji, no visible formatting.
- Never wrap up the session unless the user does.
`.trim();

const BRAIN_CAPABILITIES = `
## Your Brain

You are running inside OpenClaw as the real-time brain. Use OpenClaw tools directly for anything beyond basic conversation:
- memory and prior conversations
- calendar, tasks, files, and local tools
- web research and URLs the user asks you to inspect
- factual questions where current or user-specific context matters
- creating, updating, or remembering durable information

When in doubt, use the relevant OpenClaw tool. Do not claim you lack access until an OpenClaw tool confirms the task cannot be done.

## Mandatory Memory Rule

You do not have reliable memory of past sessions inside this live conversation. If the user asks what happened earlier, recently, last time, today, yesterday, or in any prior conversation, use OpenClaw memory or session-history tools before answering.
`.trim();

export function buildInstructions(config: VoiceClawSessionConfigEvent): string {
  const parts: string[] = [];

  if (config.brainAgent !== "none") {
    parts.push(BRAIN_CAPABILITIES);
  } else {
    parts.push("You are a helpful voice assistant. Keep responses conversational and concise.");
  }

  parts.push(CONVERSATION_RULES);

  const deviceContext = buildDeviceContext(config);
  if (deviceContext) {
    parts.push(deviceContext);
  }

  if (config.instructionsOverride?.trim()) {
    parts.push(`## About The User\n${config.instructionsOverride.trim()}`);
  }

  if (config.conversationHistory && config.conversationHistory.length > 0) {
    parts.push(buildConversationHistory(config.conversationHistory));
  }

  return parts.join("\n\n");
}

function buildDeviceContext(config: VoiceClawSessionConfigEvent): string | null {
  const ctx = config.deviceContext;
  if (!ctx) {
    return null;
  }
  const contextParts: string[] = [];
  if (ctx.timezone) {
    contextParts.push(`timezone: ${ctx.timezone}`);
  }
  if (ctx.locale) {
    contextParts.push(`locale: ${ctx.locale}`);
  }
  if (ctx.deviceModel) {
    contextParts.push(`device: ${ctx.deviceModel}`);
  }
  if (ctx.location) {
    contextParts.push(`location: ${ctx.location}`);
  }
  return contextParts.length > 0 ? `## Device Context\n${contextParts.join(", ")}` : null;
}

function buildConversationHistory(history: { role: "user" | "assistant"; text: string }[]): string {
  const lines = history
    .slice(-12)
    .map((entry) => `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text.trim()}`)
    .filter((line) => line.length > 0);
  return `## Recent Conversation History\n${lines.join("\n")}`;
}
