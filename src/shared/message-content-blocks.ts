export function visitObjectContentBlocks(
  message: unknown,
  visitor: (block: Record<string, unknown>) => void,
): void {
  if (!message || typeof message !== "object") {
    return;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    visitor(block as Record<string, unknown>);
  }
}
