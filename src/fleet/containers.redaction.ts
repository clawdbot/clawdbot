// Fleet container stream redaction preserves chunked output without leaking split secrets.
import { StringDecoder } from "node:string_decoder";

// Longest suffix of `text` that is a proper prefix of any secret. Retaining it
// across emissions guarantees no complete secret is ever split between two
// emitted chunks, and emitted text can never grow into a match later.
function secretPrefixSuffixLength(text: string, redactValues: readonly string[]): number {
  let longest = 0;
  for (const value of redactValues) {
    const max = Math.min(value.length - 1, text.length);
    for (let length = max; length > longest; length -= 1) {
      if (value.startsWith(text.slice(text.length - length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

export function createRedactingStreamWriter(
  target: NodeJS.WriteStream,
  redactValues: readonly string[],
): { write: (chunk: Buffer) => boolean; flush: () => void } {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const redact = (text: string): string => {
    let redacted = text;
    for (const value of redactValues) {
      if (value) {
        redacted = redacted.replaceAll(value, "<redacted>");
      }
    }
    return redacted;
  };
  // Returns the raw target.write() backpressure signal so callers can pause
  // the child stream instead of buffering a noisy follow stream without bound.
  const emit = (text: string): boolean => {
    if (!text) {
      return true;
    }
    return target.write(redact(text));
  };
  return {
    // Emit everything except a possible secret prefix at the tail on every
    // chunk, so unterminated output (progress lines, prompts) streams live
    // instead of stalling until a newline arrives.
    write: (chunk) => {
      pending += decoder.write(chunk);
      const keep = secretPrefixSuffixLength(pending, redactValues);
      const cut = pending.length - keep;
      if (cut <= 0) {
        return true;
      }
      const writable = emit(pending.slice(0, cut));
      pending = pending.slice(cut);
      return writable;
    },
    flush: () => {
      emit(pending + decoder.end());
      pending = "";
    },
  };
}
