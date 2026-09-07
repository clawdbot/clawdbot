import path from "node:path";

export function extractGeneratedTranscriptSessionId(sessionFile?: string): string | undefined {
  const trimmed = sessionFile?.trim();
  if (!trimmed) {
    return undefined;
  }
  const base = path.basename(trimmed);
  if (!base.endsWith(".jsonl")) {
    return undefined;
  }
  const withoutExt = base.slice(0, -".jsonl".length);
  const topicIndex = withoutExt.indexOf("-topic-");
  if (topicIndex > 0) {
    const topicSessionId = withoutExt.slice(0, topicIndex);
    return looksLikeGeneratedSessionId(topicSessionId) ? topicSessionId : undefined;
  }
  const forkMatch = withoutExt.match(
    /^(\d{4}-\d{2}-\d{2}T[\w-]+(?:Z|[+-]\d{2}(?:-\d{2})?)?)_(.+)$/,
  );
  if (forkMatch?.[2]) {
    return looksLikeGeneratedSessionId(forkMatch[2]) ? forkMatch[2] : undefined;
  }
  return looksLikeGeneratedSessionId(withoutExt) ? withoutExt : undefined;
}

function looksLikeGeneratedSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
