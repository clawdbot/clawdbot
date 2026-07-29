/**
 * Message-provider tool filtering.
 * Channels can restrict tool names after runtime assembly when the active
 * transport cannot safely render or execute a class of tools.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

const TOOL_DENY_BY_MESSAGE_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  "discord-voice": ["tts"],
  voice: ["tts"],
};

const TOOL_ALLOW_BY_MESSAGE_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  node: ["canvas", "image", "pdf", "tts", "web_fetch", "web_search"],
};

/** Applies message-provider filtering while preserving duplicate tool entries. */
export function filterToolsByMessageProvider<TTool extends { name: string }>(
  tools: readonly TTool[],
  messageProvider?: string,
): TTool[] {
  const normalizedProvider = normalizeOptionalLowercaseString(messageProvider);
  if (!normalizedProvider) {
    return [...tools];
  }
  const allowedTools = TOOL_ALLOW_BY_MESSAGE_PROVIDER[normalizedProvider];
  if (allowedTools && allowedTools.length > 0) {
    const allowedSet = new Set(allowedTools);
    return tools.filter((tool) => allowedSet.has(tool.name));
  }
  const deniedTools = TOOL_DENY_BY_MESSAGE_PROVIDER[normalizedProvider];
  if (!deniedTools || deniedTools.length === 0) {
    return [...tools];
  }
  const deniedSet = new Set(deniedTools);
  return tools.filter((tool) => !deniedSet.has(tool.name));
}
