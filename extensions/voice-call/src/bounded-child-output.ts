// Bounded child-process output buffer for voice-call tunnel/process diagnostics.
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const DEFAULT_MAX_OUTPUT_CHARS = 16_384;

/** Captured child output plus truncation flag. */
type BoundedChildOutput = {
  text: string;
  truncated: boolean;
};

/** Create an empty bounded output buffer. */
export function emptyBoundedChildOutput(): BoundedChildOutput {
  return { text: "", truncated: false };
}

/** Append output while retaining the newest maxChars and recording truncation. */
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
    text: sliceUtf16Safe(appended, -maxChars),
    truncated: true,
  };
}

/** Format captured output with a truncation marker when older text was dropped. */
export function formatBoundedChildOutput(output: BoundedChildOutput): string {
  return output.truncated ? `[output truncated]\n${output.text}` : output.text;
}
