export type EmbeddingInputTextPart = {
  type: "text";
  text: string;
};

export type EmbeddingInputInlineDataPart = {
  type: "inline-data";
  mimeType: string;
  data: string;
};

export type EmbeddingInputPart = EmbeddingInputTextPart | EmbeddingInputInlineDataPart;

export type EmbeddingInput = {
  text: string;
  parts?: EmbeddingInputPart[];
};

export function buildTextEmbeddingInput(text: string): EmbeddingInput {
  return { text };
}

function isInlineDataEmbeddingInputPart(
  part: EmbeddingInputPart,
): part is EmbeddingInputInlineDataPart {
  return part.type === "inline-data";
}

export function hasNonTextEmbeddingParts(input: EmbeddingInput | undefined): boolean {
  if (!input?.parts?.length) {
    return false;
  }
  return input.parts.some((part) => isInlineDataEmbeddingInputPart(part));
}
