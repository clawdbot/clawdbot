// Public embedding input contract for text and inline multimodal parts.

/** Text part passed through embedding providers that support structured input. */
export type EmbeddingInputTextPart = {
  type: "text";
  text: string;
};

/** Inline binary payload encoded for providers with multimodal embedding support. */
export type EmbeddingInputInlineDataPart = {
  type: "inline-data";
  mimeType: string;
  data: string;
};

/** Single structured embedding input part. */
export type EmbeddingInputPart = EmbeddingInputTextPart | EmbeddingInputInlineDataPart;

/** Provider-facing input while preserving the plain text fallback. */
export type EmbeddingInput = {
  text: string;
  parts?: EmbeddingInputPart[];
};

/** Build the common text-only embedding input shape. */
export function buildTextEmbeddingInput(text: string): EmbeddingInput {
  return { text };
}

/** Narrow an embedding part to an inline-data payload. */
export function isInlineDataEmbeddingInputPart(
  part: EmbeddingInputPart,
): part is EmbeddingInputInlineDataPart {
  return part.type === "inline-data";
}

/** Return true when a chunk needs structured provider handling, not text splitting. */
export function hasNonTextEmbeddingParts(input: EmbeddingInput | undefined): boolean {
  if (!input?.parts?.length) {
    return false;
  }
  return input.parts.some((part) => isInlineDataEmbeddingInputPart(part));
}
