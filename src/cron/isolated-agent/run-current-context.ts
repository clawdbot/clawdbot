/** Bounded source-conversation context for current-bound cron runs. */
import type { SessionEntry } from "../../config/sessions.js";
import { projectChatDisplayMessages } from "../../gateway/chat-display-projection.js";
import { readSessionMessagesAsync } from "../../gateway/session-transcript-readers.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { truncateUtf16Safe } from "../../utils.js";

const CURRENT_CONTEXT_MAX_MESSAGES = 10;
const CURRENT_CONTEXT_RAW_MESSAGES_MAX = CURRENT_CONTEXT_MAX_MESSAGES * 20 + 20;
const CURRENT_CONTEXT_READ_MAX_BYTES = 256 * 1024;
const CURRENT_CONTEXT_MAX_LINE_CHARS = 220;
const CURRENT_CONTEXT_MAX_BLOCK_CHARS = 1400;
const CURRENT_CONTEXT_HEADER = "Recent conversation:";

type ReadSessionMessages = typeof readSessionMessagesAsync;

function truncateContextLine(role: "user" | "assistant", text: string): string {
  const label = role === "user" ? "User" : "Assistant";
  const prefix = `- ${label}: `;
  const textLimit = CURRENT_CONTEXT_MAX_LINE_CHARS - prefix.length;
  if (text.length <= textLimit) {
    return `${prefix}${text}`;
  }
  const truncated = truncateUtf16Safe(text, textLimit - 3).trimEnd();
  return `${prefix}${truncated}...`;
}

function formatCurrentConversationContext(messages: unknown[]): string | undefined {
  const lines = projectChatDisplayMessages(messages, {
    maxChars: CURRENT_CONTEXT_MAX_LINE_CHARS,
  })
    .flatMap((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return [];
      }
      const record = message as { role?: unknown; content?: unknown };
      if (record.role !== "user" && record.role !== "assistant") {
        return [];
      }
      const text = extractTextFromChatContent(record.content);
      return text ? [truncateContextLine(record.role, text)] : [];
    })
    .slice(-CURRENT_CONTEXT_MAX_MESSAGES);

  while (
    lines.length > 0 &&
    `${CURRENT_CONTEXT_HEADER}\n${lines.join("\n")}`.length > CURRENT_CONTEXT_MAX_BLOCK_CHARS
  ) {
    lines.shift();
  }
  return lines.length > 0 ? `${CURRENT_CONTEXT_HEADER}\n${lines.join("\n")}` : undefined;
}

export async function buildCurrentConversationContextBlock(
  params: {
    agentId: string;
    sourceSessionEntry: SessionEntry;
    sourceSessionKey: string;
    storePath: string;
  },
  deps: { readSessionMessages?: ReadSessionMessages } = {},
): Promise<string | undefined> {
  const sessionId = params.sourceSessionEntry.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  try {
    const messages = await (deps.readSessionMessages ?? readSessionMessagesAsync)(
      {
        agentId: params.agentId,
        sessionEntry: params.sourceSessionEntry,
        sessionId,
        sessionKey: params.sourceSessionKey,
        storePath: params.storePath,
      },
      {
        mode: "recent",
        maxBytes: CURRENT_CONTEXT_READ_MAX_BYTES,
        maxLines: CURRENT_CONTEXT_RAW_MESSAGES_MAX,
        maxMessages: CURRENT_CONTEXT_RAW_MESSAGES_MAX,
      },
    );
    return formatCurrentConversationContext(Array.isArray(messages) ? messages : []);
  } catch {
    return undefined;
  }
}
