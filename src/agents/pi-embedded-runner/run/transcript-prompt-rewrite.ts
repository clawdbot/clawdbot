import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { emitSessionTranscriptUpdate } from "../../../sessions/transcript-events.js";
import { rewriteTranscriptEntriesInSessionManager } from "../transcript-rewrite.js";

type SessionManagerLike = ReturnType<typeof SessionManager.open>;

function extractPromptTextFromMessage(message: AgentMessage): string | undefined {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textBlocks = content
    .map((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : undefined,
    )
    .filter((text): text is string => typeof text === "string");
  return textBlocks.length > 0 ? textBlocks.join("") : undefined;
}

function replacePromptTextInMessage(message: AgentMessage, text: string): AgentMessage {
  const content = (message as { content?: unknown }).content;
  const entry = message as unknown as Record<string, unknown>;
  if (typeof content === "string") {
    return { ...entry, content: text } as AgentMessage;
  }
  if (!Array.isArray(content)) {
    return { ...entry, content: text } as AgentMessage;
  }
  let replaced = false;
  const nextContent: unknown[] = [];
  for (const block of content) {
    if (
      replaced ||
      !block ||
      typeof block !== "object" ||
      typeof (block as { text?: unknown }).text !== "string"
    ) {
      nextContent.push(block);
      continue;
    }
    replaced = true;
    nextContent.push({ ...(block as Record<string, unknown>), text });
  }
  return {
    ...entry,
    content: replaced ? nextContent : text,
  } as AgentMessage;
}

export function rewriteSubmittedPromptTranscript(params: {
  sessionManager: SessionManagerLike;
  sessionFile: string;
  previousLeafId: string | null;
  submittedPrompt: string;
  transcriptPrompt?: string;
}): void {
  const transcriptPrompt = params.transcriptPrompt;
  if (transcriptPrompt === undefined || transcriptPrompt === params.submittedPrompt) {
    return;
  }
  const replacementText = transcriptPrompt.trim() || "[OpenClaw runtime event]";
  const branch = params.sessionManager.getBranch();
  const startIndex = params.previousLeafId
    ? Math.max(0, branch.findIndex((entry) => entry.id === params.previousLeafId) + 1)
    : 0;
  const target = branch.slice(startIndex).find((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") {
      return false;
    }
    const text = extractPromptTextFromMessage(entry.message as AgentMessage);
    return text === params.submittedPrompt;
  });
  if (!target || target.type !== "message") {
    return;
  }
  const result = rewriteTranscriptEntriesInSessionManager({
    sessionManager: params.sessionManager,
    replacements: [
      {
        entryId: target.id,
        message: replacePromptTextInMessage(target.message, replacementText),
      },
    ],
  });
  if (result.changed) {
    emitSessionTranscriptUpdate(params.sessionFile);
  }
}
