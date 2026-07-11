import { readRecentUserAssistantTextForSession } from "openclaw/plugin-sdk/session-store-runtime";

type BuildTelegramSessionTranscriptPromptMessagesParams = Parameters<
  typeof readRecentUserAssistantTextForSession
>[0] & { agentId: string; limit: number };

export async function buildTelegramSessionTranscriptPromptEntries(
  params: BuildTelegramSessionTranscriptPromptMessagesParams,
) {
  const entries = await readRecentUserAssistantTextForSession(params);
  return entries.map((entry) => {
    const sender = entry.role === "assistant" ? "OpenClaw" : "User";
    const message = {
      ...(entry.id ? { message_id: `session:${entry.id}` } : {}),
      sender: entry.sourceChannel ? `${sender} (${entry.sourceChannel})` : sender,
      ...(entry.timestamp !== undefined ? { timestamp_ms: entry.timestamp } : {}),
      body: entry.text,
      ...(entry.sourceChannel ? { source_channel: entry.sourceChannel } : {}),
    };
    return entry.id
      ? { role: entry.role, transcriptMessageId: entry.id, message }
      : { role: entry.role, message };
  });
}
