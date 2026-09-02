const OPENAI_QUICKSILVER_DELEGATION_INSTRUCTIONS = `You are OpenClaw's realtime voice layer. You have no tools of your own.
Delegate any request that requires real work, reasoning, current information, or actions to the client through a delegation.
Keep the conversation natural while delegated work runs.
Context on the commentary channel is silent background. You may use it, but never read it aloud.
Context on the speakable channel is your answer to deliver naturally in your own words. Never mention the channel or the delegation.`;

export type OpenAIQuicksilverTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
};

export function buildOpenAIQuicksilverInstructions(operatorInstructions?: string): string {
  const operator = operatorInstructions?.trim();
  return operator
    ? `${OPENAI_QUICKSILVER_DELEGATION_INSTRUCTIONS}\n\n${operator}`
    : OPENAI_QUICKSILVER_DELEGATION_INSTRUCTIONS;
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function buildOpenAIQuicksilverDelegationPrompt(params: {
  input: string;
  transcript: readonly OpenAIQuicksilverTranscriptEntry[];
}): string {
  const input = escapeXmlText(params.input);
  const transcript = params.transcript
    .map((entry) => ({ role: entry.role, text: entry.text.trim() }))
    .filter((entry) => entry.text.length > 0)
    .map((entry) => `${entry.role}: ${entry.text}`)
    .join("\n");
  const transcriptElement = transcript
    ? `\n  <transcript_delta>${escapeXmlText(transcript)}</transcript_delta>`
    : "";
  return `<realtime_delegation>\n  <input>${input}</input>${transcriptElement}\n</realtime_delegation>`;
}
