const TEXT_BLOCK_TYPES = new Set(["text", "input_text", "output_text"]);

function readTextValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { value?: unknown }).value === "string"
  ) {
    return (value as { value: string }).value;
  }
  return "";
}

function extractTextBlock(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }
  const type = (block as { type?: unknown }).type;
  if (typeof type !== "string" || !TEXT_BLOCK_TYPES.has(type)) {
    return "";
  }
  return readTextValue((block as { text?: unknown }).text);
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(extractTextBlock).filter(Boolean).join("\n");
  }
  return extractTextBlock(content);
}

export function extractTranscriptText(messages: unknown[]): Array<{ role: string; text: string }> {
  const result: Array<{ role: string; text: string }> = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    if (typeof role !== "string") {
      continue;
    }
    const text = extractMessageText(content).trim();
    if (text) {
      result.push({ role, text });
    }
  }
  return result;
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
