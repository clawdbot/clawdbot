const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function truncateGraphemes(text: string, max: number): string {
  const graphemes: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    if (graphemes.length === max) {
      return `${graphemes.slice(0, -1).join("")}…`;
    }
    graphemes.push(segment);
  }
  return text;
}
