export type McpCodeModeMentions = Record<
  "apiCall" | "apiFileList" | "apiFileRead" | "mcpNamespace" | "mcpTool" | "toolSearchPollution",
  number
>;

/** Extracts actual assistant tool calls, never prompt or assistant prose. */
export function extractMcpCodeModePlannedTools(transcriptEvents: readonly unknown[]): string[] {
  return transcriptEvents.flatMap((event) => {
    if (!event || typeof event !== "object") {
      return [];
    }
    const message = (event as { message?: unknown }).message;
    if (!message || typeof message !== "object") {
      return [];
    }
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== "assistant" || !Array.isArray(content)) {
      return [];
    }
    return content.flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      const { type, name } = block as { type?: unknown; name?: unknown };
      return (type === "toolCall" || type === "tool_use" || type === "tool_call") &&
        typeof name === "string"
        ? [name]
        : [];
    });
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function outputText(response: unknown): string {
  const output = (response as { output?: Array<{ type?: unknown; content?: unknown }> }).output;
  if (!Array.isArray(output)) {
    return "";
  }
  return output
    .flatMap((item) => {
      if (item.type !== "message" || !Array.isArray(item.content)) {
        return [];
      }
      return item.content.flatMap((piece) => {
        if (!piece || typeof piece !== "object") {
          return [];
        }
        const record = piece as { text?: unknown };
        return typeof record.text === "string" ? [record.text] : [];
      });
    })
    .join("\n");
}

export function validateMcpCodeModeResult(
  response: unknown,
  mentions: McpCodeModeMentions,
  options: { plannedTools?: string[]; requireExec?: boolean } = {},
): string {
  const finalText = outputText(response);
  assert(
    finalText.includes("MCP_CODE_MODE_FILE_OK"),
    `agent did not complete MCP API file check: ${finalText}`,
  );
  assert(
    finalText.includes("fixture-note-alpha"),
    `agent did not return fixture note from MCP call: ${finalText}`,
  );
  assert(
    !/MCP\s+(?:was\s+)?not\s+defined|failed|error/i.test(finalText),
    `agent reported MCP failure instead of a successful call: ${finalText}`,
  );
  if (options.requireExec) {
    assert(options.plannedTools?.includes("exec"), "agent did not call code-mode exec");
  }
  assert(mentions.apiFileList > 0, "session log lacks API.list usage");
  assert(mentions.apiFileRead > 0, "session log lacks API.read usage");
  assert(mentions.mcpNamespace > 0, "session log lacks MCP.fixture usage");
  assert(mentions.mcpTool > 0, "session log lacks MCP.fixture.lookupNote call");
  assert(mentions.apiCall === 0, "agent should not call MCP.$api when API files are available");
  assert(mentions.toolSearchPollution === 0, "agent should not use tools.search for MCP lookup");
  return finalText;
}
