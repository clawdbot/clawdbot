/** Request facts shared by Copilot transports; identity headers remain plugin-owned. */
export function projectCopilotRequestFacts(
  messages: readonly { role: string; content: unknown }[],
  contentMode: "direct" | "nested",
  hasImages?: boolean,
): { initiator: "user" | "agent"; hasImages: boolean } {
  const last = messages.at(-1);
  const initiator =
    last &&
    (last.role !== "user" ||
      (contentMode === "nested" && containsContentType(last.content, "tool_result")))
      ? "agent"
      : "user";
  return {
    initiator,
    hasImages:
      hasImages ??
      messages.some(
        (message) =>
          (message.role === "user" || message.role === "toolResult") &&
          Array.isArray(message.content) &&
          message.content.some((item) => containsContentType(item, "image", contentMode)),
      ),
  };
}

function containsContentType(
  value: unknown,
  type: string,
  contentMode: "direct" | "nested" = "nested",
): boolean {
  if (contentMode === "nested" && Array.isArray(value)) {
    return value.some((item) => containsContentType(item, type));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return (
    ("type" in value && value.type === type) ||
    (contentMode === "nested" && "content" in value && containsContentType(value.content, type))
  );
}
