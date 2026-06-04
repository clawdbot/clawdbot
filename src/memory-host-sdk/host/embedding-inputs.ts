/** Plain text segment accepted by embedding providers. */
export type EmbeddingInputTextPart = {
  type: "text";
  text: string;
};

/** Base64 inline payload segment for multimodal embedding providers. */
export type EmbeddingInputInlineDataPart = {
  type: "inline-data";
  mimeType: string;
  data: string;
};

/** Provider-neutral embedding input part. */
export type EmbeddingInputPart = EmbeddingInputTextPart | EmbeddingInputInlineDataPart;

/** Embedding input preserving legacy text plus optional structured parts. */
export type EmbeddingInput = {
  text: string;
  parts?: EmbeddingInputPart[];
};

/** Build a text-only embedding input while keeping callers on the structured API. */
export function buildTextEmbeddingInput(text: string): EmbeddingInput {
  return { text };
}

function isInlineDataEmbeddingInputPart(
  part: EmbeddingInputPart,
): part is EmbeddingInputInlineDataPart {
  return part.type === "inline-data";
}

/** Return true when an embedding request needs multimodal provider support. */
export function hasNonTextEmbeddingParts(input: EmbeddingInput | undefined): boolean {
  if (!input?.parts?.length) {
    return false;
  }
  return input.parts.some((part) => isInlineDataEmbeddingInputPart(part));
}
