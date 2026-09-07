export function sparseAssistant(content: unknown[]) {
  return { role: "assistant" as const, content };
}

export function textToolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  fields?: { isError?: boolean },
) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName,
    content: [{ type: "text" as const, text }],
    ...fields,
  };
}
