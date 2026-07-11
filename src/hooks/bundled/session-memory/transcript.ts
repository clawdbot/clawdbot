// Session memory transcript helpers persist compact session transcript excerpts.
import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeModelSpecialTokens } from "../../../security/external-content.js";
import { hasInterSessionUserProvenance } from "../../../sessions/input-provenance.js";
import { isOpenClawDeliveryMirrorAssistantMessage } from "../../../shared/transcript-only-openclaw-assistant.js";

const SESSION_MEMORY_TOOL_DIRECTIVE_PREFIX = String.raw`(?:(?:\|DSML\|)|(?:\uFF5CDSML\uFF5C))?`;
const SESSION_MEMORY_TOOL_DIRECTIVE_KIND = String.raw`(?:tool_calls?|function_calls?|tool_use_error)`;
const SESSION_MEMORY_DROP_BLOCK_RE = new RegExp(
  String.raw`<${SESSION_MEMORY_TOOL_DIRECTIVE_PREFIX}${SESSION_MEMORY_TOOL_DIRECTIVE_KIND}\b[^>]*>` +
    String.raw`[\s\S]*?(?:<\/${SESSION_MEMORY_TOOL_DIRECTIVE_PREFIX}${SESSION_MEMORY_TOOL_DIRECTIVE_KIND}>|$)`,
  "gi",
);
const SESSION_MEMORY_ROLE_DIRECTIVE_BLOCK_RE = /<(system|assistant|user)\b[^>]*>[\s\S]*?<\/\1>/gi;
const SESSION_MEMORY_ROLE_DIRECTIVE_TAG_RE = /<\/?(?:system|assistant|user)\b[^>]*>/gi;
const SESSION_MEMORY_MEDIA_PLACEHOLDER_RE = /(^|\n)\s*<media:[^>]+>(?:\s*\([^)]*\))?\s*/gi;
const SESSION_MEMORY_TRAILING_NO_REPLY_RE = /(?:^|\n)\s*NO_REPLY\s*$/i;

function isNoReplyMarker(text: string): boolean {
  const trimmed = text.trim();
  return /^NO_REPLY$/i.test(trimmed) || /^\{\s*"action"\s*:\s*"NO_REPLY"\s*\}$/i.test(trimmed);
}

export function sanitizeSessionMemoryTranscriptText(text: string): string | null {
  if (isNoReplyMarker(text)) {
    return null;
  }
  const withoutArtifacts = sanitizeModelSpecialTokens(text)
    .replace(SESSION_MEMORY_DROP_BLOCK_RE, "")
    .replace(SESSION_MEMORY_ROLE_DIRECTIVE_BLOCK_RE, "")
    .replace(SESSION_MEMORY_ROLE_DIRECTIVE_TAG_RE, "")
    .replace(SESSION_MEMORY_MEDIA_PLACEHOLDER_RE, "$1")
    .replace(SESSION_MEMORY_TRAILING_NO_REPLY_RE, "")
    .trim();

  return withoutArtifacts || null;
}

function extractTextMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      return candidate.text;
    }
  }
  return undefined;
}

type RenderedSessionMemoryMessage = {
  isDeliveryMirror: boolean;
  role: "assistant" | "user";
  text?: string;
};

function renderSessionMemoryMessage(entry: unknown): RenderedSessionMemoryMessage | undefined {
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  const record = entry as {
    message?: {
      content?: unknown;
      provenance?: unknown;
      role?: unknown;
    };
    type?: unknown;
  };
  if (record.type !== "message" || !record.message) {
    return undefined;
  }
  const role = record.message.role;
  if ((role !== "user" && role !== "assistant") || !("content" in record.message)) {
    return undefined;
  }
  if (role === "user" && hasInterSessionUserProvenance(record.message)) {
    return undefined;
  }
  const text = extractTextMessageContent(record.message.content);
  const sanitized = text ? sanitizeSessionMemoryTranscriptText(text) : null;
  if (!sanitized) {
    return undefined;
  }
  if (sanitized.startsWith("/")) {
    return role === "user" ? { isDeliveryMirror: false, role } : undefined;
  }
  return {
    isDeliveryMirror: isOpenClawDeliveryMirrorAssistantMessage(record.message),
    role,
    text: sanitized,
  };
}

/** Renders recent user/assistant transcript events into session memory text. */
export function getRecentSessionContentFromEvents(
  events: readonly unknown[],
  messageCount = 15,
): string | null {
  const allMessages: string[] = [];
  let lastAssistantText: string | undefined;
  for (const event of events) {
    const rendered = renderSessionMemoryMessage(event);
    if (!rendered) {
      continue;
    }
    if (rendered.role === "user") {
      // New turn: reset even when slash commands are omitted from memory, so
      // later standalone delivery mirrors are preserved.
      lastAssistantText = undefined;
    }
    if (!rendered.text) {
      continue;
    }
    // Skip delivery-mirror rows only when they duplicate the preceding
    // assistant text. Delivery-mirror rows with unique visible content
    // (e.g., message-tool replies) are preserved.
    if (rendered.isDeliveryMirror && rendered.text === lastAssistantText) {
      continue;
    }
    allMessages.push(`${rendered.role}: ${rendered.text}`);
    if (rendered.role === "assistant") {
      lastAssistantText = rendered.text;
    }
  }
  return allMessages.slice(-messageCount).join("\n");
}

export async function getRecentSessionContent(
  sessionFilePath: string,
  messageCount = 15,
): Promise<string | null> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");

    return getRecentSessionContentFromEvents(
      lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      }),
      messageCount,
    );
  } catch {
    return null;
  }
}

export async function getRecentSessionContentWithResetFallback(
  sessionFilePath: string,
  messageCount = 15,
): Promise<string | null> {
  const primary = await getRecentSessionContent(sessionFilePath, messageCount);
  if (primary) {
    return primary;
  }

  try {
    const dir = path.dirname(sessionFilePath);
    const base = path.basename(sessionFilePath);
    const resetPrefix = `${base}.reset.`;
    const files = await fs.readdir(dir);
    const resetCandidates = files.filter((name) => name.startsWith(resetPrefix)).toSorted();

    if (resetCandidates.length === 0) {
      return primary;
    }

    const latestResetPath = path.join(dir, resetCandidates[resetCandidates.length - 1]);
    return (await getRecentSessionContent(latestResetPath, messageCount)) || primary;
  } catch {
    return primary;
  }
}

function stripResetSuffix(fileName: string): string {
  const resetIndex = fileName.indexOf(".reset.");
  return resetIndex === -1 ? fileName : fileName.slice(0, resetIndex);
}

export async function findPreviousSessionFile(params: {
  sessionsDir: string;
  currentSessionFile?: string;
  sessionId?: string;
}): Promise<string | undefined> {
  try {
    const files = await fs.readdir(params.sessionsDir);
    const fileSet = new Set(files);

    const currentBaseName = params.currentSessionFile
      ? path.basename(params.currentSessionFile)
      : undefined;
    const baseFromReset = currentBaseName ? stripResetSuffix(currentBaseName) : undefined;
    if (baseFromReset && fileSet.has(baseFromReset)) {
      return path.join(params.sessionsDir, baseFromReset);
    }
    if (currentBaseName?.includes(".reset.") && fileSet.has(currentBaseName)) {
      return path.join(params.sessionsDir, currentBaseName);
    }

    const trimmedSessionId = params.sessionId?.trim();
    if (trimmedSessionId) {
      const canonicalFile = `${trimmedSessionId}.jsonl`;
      if (fileSet.has(canonicalFile)) {
        return path.join(params.sessionsDir, canonicalFile);
      }

      const canonicalResetVariants = files
        .filter((name) => name.startsWith(`${canonicalFile}.reset.`))
        .toSorted()
        .toReversed();
      if (canonicalResetVariants.length > 0) {
        return path.join(params.sessionsDir, canonicalResetVariants[0]);
      }

      const topicVariants = files
        .filter(
          (name) =>
            name.startsWith(`${trimmedSessionId}-topic-`) &&
            name.endsWith(".jsonl") &&
            !name.includes(".reset."),
        )
        .toSorted()
        .toReversed();
      if (topicVariants.length > 0) {
        return path.join(params.sessionsDir, topicVariants[0]);
      }

      const topicResetVariants = files
        .filter(
          (name) => name.startsWith(`${trimmedSessionId}-topic-`) && name.includes(".jsonl.reset."),
        )
        .toSorted()
        .toReversed();
      if (topicResetVariants.length > 0) {
        return path.join(params.sessionsDir, topicResetVariants[0]);
      }
    }

    if (!params.currentSessionFile) {
      return undefined;
    }

    const nonResetJsonl = files
      .filter((name) => name.endsWith(".jsonl") && !name.includes(".reset."))
      .toSorted()
      .toReversed();
    if (nonResetJsonl.length > 0) {
      return path.join(params.sessionsDir, nonResetJsonl[0]);
    }

    const resetJsonl = files
      .filter((name) => name.includes(".jsonl.reset."))
      .toSorted()
      .toReversed();
    if (resetJsonl.length > 0) {
      return path.join(params.sessionsDir, resetJsonl[0]);
    }
  } catch {
    // Ignore directory read errors.
  }
  return undefined;
}
