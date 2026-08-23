import type { ImageContent, TextContent } from "@openclaw/llm-core";
import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { getAiTransportHost } from "../host.js";

const ANTHROPIC_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type AnthropicImageMediaType = (typeof ANTHROPIC_IMAGE_MEDIA_TYPES)[number];
const ANTHROPIC_IMAGE_MEDIA_TYPE_SET = new Set<string>(ANTHROPIC_IMAGE_MEDIA_TYPES);
// Resource-safety ceiling above Anthropic's direct request envelope; route-specific
// API limits remain provider policy rather than a shared payload-conversion rule.
const ANTHROPIC_INLINE_IMAGES_DECODE_SAFETY_BYTES = 64 * 1024 * 1024;

export type AnthropicInlineImageBudget = { totalBytes: number };

export function createAnthropicInlineImageBudget(): AnthropicInlineImageBudget {
  return { totalBytes: 0 };
}

export function resolveAnthropicImageMediaType(value: string): AnthropicImageMediaType {
  if (ANTHROPIC_IMAGE_MEDIA_TYPE_SET.has(value)) {
    return value as AnthropicImageMediaType;
  }
  throw new Error(`Unsupported Anthropic image media type after normalization: ${value}`);
}

export async function normalizeAnthropicInlineContent(
  content: readonly (TextContent | ImageContent)[],
  budget: AnthropicInlineImageBudget,
): Promise<Array<TextContent | ImageContent>> {
  if (!content.some((block) => block.type === "image")) {
    return content.filter((block): block is TextContent => block.type === "text");
  }
  const inputBytes = content.reduce(
    (total, block) =>
      block.type === "image" ? total + estimateBase64DecodedBytes(block.data) : total,
    0,
  );
  if (budget.totalBytes + inputBytes > ANTHROPIC_INLINE_IMAGES_DECODE_SAFETY_BYTES) {
    throw new Error("Anthropic inline images exceed the 64 MB aggregate decoded safety limit.");
  }
  const normalized: Array<TextContent | ImageContent> = [];
  for (const block of content) {
    if (block.type !== "image") {
      normalized.push(block);
      continue;
    }
    const normalizedBlocks = await getAiTransportHost().normalizeAnthropicInlineContentBlocks([
      block,
    ]);
    const outputBytes = normalizedBlocks.reduce(
      (total, normalizedBlock) =>
        normalizedBlock.type === "image"
          ? total + estimateBase64DecodedBytes(normalizedBlock.data)
          : total,
      0,
    );
    if (budget.totalBytes + outputBytes > ANTHROPIC_INLINE_IMAGES_DECODE_SAFETY_BYTES) {
      throw new Error("Anthropic inline images exceed the 64 MB aggregate decoded safety limit.");
    }
    budget.totalBytes += outputBytes;
    normalized.push(...normalizedBlocks);
  }
  return normalized;
}
