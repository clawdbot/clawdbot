import { sliceCodePoints } from "@openclaw/normalization-core/code-points";

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export function takeGraphemes(input: string, limit: number): string {
  if (!graphemeSegmenter) {
    return sliceCodePoints(input, 0, limit);
  }
  let result = "";
  let count = 0;
  for (const { segment } of graphemeSegmenter.segment(input)) {
    result += segment;
    count += 1;
    if (count >= limit) {
      break;
    }
  }
  return result;
}
