export type McpCodeModeMentions = Record<
  "apiCall" | "apiFileList" | "apiFileRead" | "mcpNamespace" | "mcpTool" | "toolSearchPollution",
  number
>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function outputText(response: unknown): string {
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
  assert(mentions.apiFileRead > 0, "session log lacks API.read usage");
  assert(mentions.mcpNamespace > 0, "session log lacks MCP.fixture usage");
  assert(mentions.mcpTool > 0, "session log lacks fixture__lookup_note call");
  assert(mentions.apiCall === 0, "agent should not call MCP.$api when API files are available");
  assert(mentions.toolSearchPollution === 0, "agent should not use tools.search for MCP lookup");
  return finalText;
}
