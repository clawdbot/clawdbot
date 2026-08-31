import { DEEPSEEK_DSML_MARKERS } from "./deepseek-dsml-grammar.js";

/**
 * DeepSeek DSML streaming text filter.
 * Removes provider-emitted DSML tool markup while buffering split tag prefixes
 * across streamed chunks.
 */
const DSML_KINDS = ["tool_use_error", "tool_calls", "tool_call", "function_calls"] as const;

const DSML_OPEN_TOKENS = DEEPSEEK_DSML_MARKERS.flatMap((marker) =>
  DSML_KINDS.map((kind) => `<${marker}${kind}>`),
);
const MAX_OPEN_TOKEN_LEN = Math.max(...DSML_OPEN_TOKENS.map((token) => token.length));

interface DeepSeekTextFilter {
  /** Push one streamed text chunk and receive any safe visible text segments. */
  push(chunk: string): string[];
  /** Flush buffered text at stream end, dropping any unterminated DSML block. */
  flush(): string[];
}

/** Create an incremental text filter that strips DeepSeek DSML tool blocks. */
export function createDeepSeekTextFilter(): DeepSeekTextFilter {
  let buffer = "";
  // Only the matching delimiter and kind may end the block being suppressed.
  let closeToken: string | undefined;

  const consume = (final: boolean): string[] => {
    const output: string[] = [];
    const emit = (text: string) => {
      if (text) {
        output.push(text);
      }
    };

    while (buffer) {
      if (closeToken) {
        const closeIndex = buffer.indexOf(closeToken);
        if (closeIndex !== -1) {
          buffer = buffer.slice(closeIndex + closeToken.length);
          closeToken = undefined;
          continue;
        }
        // Keep a suffix that could still become a closing tag once the next
        // streamed chunk arrives; on final flush, drop the unterminated block.
        const keep = final ? 0 : Math.min(buffer.length, closeToken.length - 1);
        buffer = buffer.slice(buffer.length - keep);
        if (final) {
          closeToken = undefined;
        }
        return output;
      }

      const open = findEarliestToken(buffer, DSML_OPEN_TOKENS);
      if (open) {
        emit(buffer.slice(0, open.index));
        buffer = buffer.slice(open.index + open.token.length);
        closeToken = open.token.replace("<", "</");
        continue;
      }

      if (final) {
        emit(buffer);
        buffer = "";
        return output;
      }

      const keep = longestDsmlOpenPrefixSuffixLength(buffer);
      const emitLength = buffer.length - keep;
      if (emitLength <= 0) {
        return output;
      }
      emit(buffer.slice(0, emitLength));
      buffer = buffer.slice(emitLength);
      return output;
    }
    return output;
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      return consume(false);
    },
    flush() {
      return consume(true);
    },
  };
}

function findEarliestToken(text: string, tokens: readonly string[]) {
  let best: { index: number; token: string } | null = null;
  for (const token of tokens) {
    const index = text.indexOf(token);
    if (index !== -1 && (!best || index < best.index)) {
      best = { index, token };
    }
  }
  return best;
}

function longestDsmlOpenPrefixSuffixLength(text: string) {
  // Preserve only the longest suffix that could be the beginning of a future
  // opening token, so ordinary text streams immediately.
  const maxLength = Math.min(text.length, MAX_OPEN_TOKEN_LEN - 1);
  for (let length = maxLength; length > 0; length--) {
    const suffix = text.slice(text.length - length);
    if (DSML_OPEN_TOKENS.some((token) => token.startsWith(suffix))) {
      return length;
    }
  }
  return 0;
}
