import type {
  BranchSummaryResult as CoreBranchSummaryResult,
  AgentMessage,
} from "../runtime/index.js";
import { estimateTokens } from "../runtime/index.js";

export function unwrapCoreResult<T>(
  result: { ok: true; value: T } | { ok: false; error: Error },
): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

export function normalizeBranchSummaryResult(
  result:
    | { ok: true; value: CoreBranchSummaryResult }
    | { ok: false; error: { code: string; message: string } },
): {
  summary?: string;
  readFiles?: string[];
  modifiedFiles?: string[];
  aborted?: boolean;
  error?: string;
} {
  if (result.ok) {
    return result.value;
  }
  if (result.error.code === "aborted") {
    return { aborted: true, error: result.error.message };
  }
  return { error: result.error.message };
}

export function hasPersistedAssistantContent(content: unknown): boolean {
  return (typeof content === "string" || Array.isArray(content)) && content.length > 0;
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      text += candidate.text;
    }
  }
  return text;
}

export interface ParsedSkillBlock {
  name: string;
  location: string;
  content: string;
  userMessage: string | undefined;
}

export function parseSkillBlock(text: string): ParsedSkillBlock | null {
  const match = text.match(
    /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/,
  );
  if (!match) {
    return null;
  }
  const [, name, location, content, userMessage] = match;
  if (name === undefined || location === undefined || content === undefined) {
    return null;
  }
  return { name, location, content, userMessage: userMessage?.trim() || undefined };
}

export function estimateMessagesFromContent(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}
