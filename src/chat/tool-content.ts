export type ToolContentBlock = Record<string, unknown>;

function normalizeToolContentType(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function isToolCallContentType(value: unknown): boolean {
  const type = normalizeToolContentType(value);
  return type === "toolcall" || type === "tool_call" || type === "tooluse" || type === "tool_use";
}

export function isToolResultContentType(value: unknown): boolean {
  const type = normalizeToolContentType(value);
  return type === "toolresult" || type === "tool_result";
}

export function isToolCallBlock(block: ToolContentBlock): boolean {
  return isToolCallContentType(block.type);
}

export function isToolResultBlock(block: ToolContentBlock): boolean {
  return isToolResultContentType(block.type);
}

export function resolveToolBlockArgs(block: ToolContentBlock): unknown {
  return block.args ?? block.arguments ?? block.input;
}

export function resolveToolUseId(block: ToolContentBlock): string | undefined {
  const id =
    (typeof block.id === "string" && block.id.trim()) ||
    (typeof block.tool_use_id === "string" && block.tool_use_id.trim()) ||
    (typeof block.toolUseId === "string" && block.toolUseId.trim());
  return id || undefined;
}
