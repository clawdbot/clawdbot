function hasJSON5Comments(raw: string): boolean {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "/" && (raw[index + 1] === "/" || raw[index + 1] === "*")) {
      return true;
    }
  }
  return false;
}

export function warnIfJSON5CommentsWillBeStripped(params: {
  raw: string | null | undefined;
  filePath: string;
  warn?: (message: string) => void;
  skipOutputLogs?: boolean;
}): void {
  if (params.skipOutputLogs || typeof params.raw !== "string" || !hasJSON5Comments(params.raw)) {
    return;
  }
  (params.warn ?? console.warn)(`Config write will strip JSON5 comments from ${params.filePath}.`);
}
