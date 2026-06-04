/** Parsed command-line option token, preserving whether `=` appeared in the original token. */
export type InlineOptionToken =
  | {
      name: string;
      hasInlineValue: false;
    }
  | {
      name: string;
      hasInlineValue: true;
      inlineValue: string;
    };

/** Splits one CLI-style option token into its flag name and optional inline value. */
export function parseInlineOptionToken(token: string): InlineOptionToken {
  const separatorIndex = token.indexOf("=");
  if (separatorIndex < 0) {
    return { name: token, hasInlineValue: false };
  }
  // Only the first separator is structural; subsequent `=` bytes belong to values like tokens,
  // query strings, or file names passed through root/daemon command options.
  return {
    name: token.slice(0, separatorIndex),
    hasInlineValue: true,
    inlineValue: token.slice(separatorIndex + 1),
  };
}
