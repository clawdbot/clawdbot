type SourceMappedToken = {
  map?: [number, number] | null;
};

/** Prepare the next mapped block start for each token in one reverse pass. */
export function computeNextMappedBlockStarts(tokens: readonly SourceMappedToken[]) {
  const nextStarts: Array<number | undefined> = [];
  let nextStart: number | undefined;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    nextStarts[index] = nextStart;
    const currentStart = tokens[index]?.map?.[0];
    if (currentStart !== undefined) {
      nextStart = currentStart;
    }
  }
  return nextStarts;
}

export function sourceBlockNewlineCount(
  preserveSourceBlockSpacing: boolean,
  nextBlockStart: number | undefined,
  blockLineEnd: number | undefined,
): number | undefined {
  if (!preserveSourceBlockSpacing || blockLineEnd === undefined) {
    return undefined;
  }
  return nextBlockStart === undefined ? 0 : Math.max(1, nextBlockStart - blockLineEnd + 1);
}
