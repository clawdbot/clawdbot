const DEFAULT_MAX_OUTPUT_CHARS = 16_384;

export type BoundedChildOutput = {
  text: string;
  truncated: boolean;
};

export function emptyBoundedChildOutput(): BoundedChildOutput {
  return { text: "", truncated: false };
}

export function appendBoundedChildOutput(
  current: BoundedChildOutput,
  chunk: string,
  maxChars = DEFAULT_MAX_OUTPUT_CHARS,
): BoundedChildOutput {
  const appended = current.text + chunk;
  if (appended.length <= maxChars) {
    return { text: appended, truncated: current.truncated };
  }
  return {
    text: appended.slice(-maxChars),
    truncated: true,
  };
}

export function formatBoundedChildOutput(output: BoundedChildOutput): string {
  return output.truncated ? `[output truncated]\n${output.text}` : output.text;
}
