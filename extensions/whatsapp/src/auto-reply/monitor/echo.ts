export type EchoTracker = {
  rememberText: (
    text: string | undefined,
    opts: {
      combinedBody?: string;
      combinedBodySessionKey?: string;
      logVerboseMessage?: boolean;
    },
  ) => void;
  has: (key: string) => boolean;
  forget: (key: string) => void;
  buildCombinedKey: (params: { sessionKey: string; combinedBody: string }) => string;
};

export function createEchoTracker(params: {
  maxItems?: number;
  logVerbose?: (msg: string) => void;
}): EchoTracker {
  const recentlySent = new Set<string>();
  const maxItems = Math.max(1, params.maxItems ?? 100);

  const buildCombinedKey = (p: { sessionKey: string; combinedBody: string }) =>
    `combined:${p.sessionKey}:${p.combinedBody}`;

  const trim = () => {
    while (recentlySent.size > maxItems) {
      const firstKey = recentlySent.values().next().value;
      if (!firstKey) {
        break;
      }
      recentlySent.delete(firstKey);
    }
  };

  const rememberText: EchoTracker["rememberText"] = (text, opts) => {
    if (!text) {
      return;
    }
    recentlySent.add(text);
    if (opts.combinedBody && opts.combinedBodySessionKey) {
      recentlySent.add(
        buildCombinedKey({
          sessionKey: opts.combinedBodySessionKey,
          combinedBody: opts.combinedBody,
        }),
      );
    }
    if (opts.logVerboseMessage) {
      params.logVerbose?.(
        `Added to echo detection set (size now: ${recentlySent.size}): ${text.substring(0, 50)}...`,
      );
    }
    trim();
  };

  return {
    rememberText,
    has: (key) => recentlySent.has(key),
    forget: (key) => {
      recentlySent.delete(key);
    },
    buildCombinedKey,
  };
}
