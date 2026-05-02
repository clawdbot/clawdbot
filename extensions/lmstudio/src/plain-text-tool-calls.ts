import { randomUUID } from "node:crypto";
import { parseStandalonePlainTextToolCallBlocks } from "openclaw/plugin-sdk/tool-payload";

type LmstudioPlainTextToolCallBlock = {
  arguments: Record<string, unknown>;
  name: string;
};

const MAX_PAYLOAD_CHARS = 256_000;

export function parseLmstudioPlainTextToolCalls(
  text: string,
  allowedToolNames: Set<string>,
): LmstudioPlainTextToolCallBlock[] | null {
  const blocks = parseStandalonePlainTextToolCallBlocks(text, {
    allowedToolNames,
    maxPayloadBytes: MAX_PAYLOAD_CHARS,
  });
  return blocks?.map((block) => ({ arguments: block.arguments, name: block.name })) ?? null;
}

export function createLmstudioSyntheticToolCallId(): string {
  return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
