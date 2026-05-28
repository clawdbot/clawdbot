import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

const TOOL_DENY_BY_MESSAGE_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  "discord-voice": ["tts"],
  voice: ["tts"],
};

const TOOL_ALLOW_BY_MESSAGE_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  node: ["canvas", "image", "pdf", "tts", "web_fetch", "web_search"],
};

export function filterToolNamesByMessageProvider(
  toolNames: readonly string[],
  messageProvider?: string,
): string[] {
  const normalizedProvider = normalizeOptionalLowercaseString(messageProvider);
  if (!normalizedProvider) {
    return [...toolNames];
  }
  const allowedTools = TOOL_ALLOW_BY_MESSAGE_PROVIDER[normalizedProvider];
  if (allowedTools && allowedTools.length > 0) {
    const allowedSet = new Set(allowedTools);
    return toolNames.filter((toolName) => allowedSet.has(toolName));
  }
  const deniedTools = TOOL_DENY_BY_MESSAGE_PROVIDER[normalizedProvider];
  if (!deniedTools || deniedTools.length === 0) {
    return [...toolNames];
  }
  const deniedSet = new Set(deniedTools);
  return toolNames.filter((toolName) => !deniedSet.has(toolName));
}

export function filterToolsByMessageProvider<TTool extends { name: string }>(
  tools: readonly TTool[],
  messageProvider?: string,
): TTool[] {
  const filteredToolNames = filterToolNamesByMessageProvider(
    tools.map((tool) => tool.name),
    messageProvider,
  );
  const remainingCounts = new Map<string, number>();
  for (const toolName of filteredToolNames) {
    remainingCounts.set(toolName, (remainingCounts.get(toolName) ?? 0) + 1);
  }
  return tools.filter((tool) => {
    const remaining = remainingCounts.get(tool.name) ?? 0;
    if (remaining <= 0) {
      return false;
    }
    remainingCounts.set(tool.name, remaining - 1);
    return true;
  });
}
