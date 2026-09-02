// Vector normalization helpers used before embedding similarity search.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** Validate provider embeddings and restore their original request order. */
export function readEmbeddingVectors(
  data: unknown,
  expectedCount: number | undefined,
  errorPrefix: string,
): number[][] {
  const malformedResponse = () => new Error(`${errorPrefix}: malformed JSON response`);
  if (!Array.isArray(data) || (expectedCount !== undefined && data.length !== expectedCount)) {
    throw malformedResponse();
  }
  const vectors: number[][] = [];
  let indexed: boolean | undefined;
  for (let position = 0; position < data.length; position += 1) {
    const entry = asOptionalRecord(data[position]);
    const embedding = entry?.embedding;
    const usesIndex = entry?.index !== undefined;
    if (
      !entry ||
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      (indexed !== undefined && indexed !== usesIndex)
    ) {
      throw malformedResponse();
    }
    for (const coordinate of embedding) {
      if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
        throw malformedResponse();
      }
    }
    indexed = usesIndex;
    const index = usesIndex ? entry.index : position;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= data.length ||
      vectors[index] !== undefined
    ) {
      throw malformedResponse();
    }
    vectors[index] = embedding;
  }
  return vectors;
}

/** Replace invalid coordinates and L2-normalize non-empty vectors. */
export function sanitizeAndNormalizeEmbedding(vec: number[]): number[] {
  const sanitized = vec.map((value) => (Number.isFinite(value) ? value : 0));
  const magnitude = Math.sqrt(sanitized.reduce((sum, value) => sum + value * value, 0));
  if (magnitude < 1e-10) {
    return sanitized;
  }
  return sanitized.map((value) => value / magnitude);
}
