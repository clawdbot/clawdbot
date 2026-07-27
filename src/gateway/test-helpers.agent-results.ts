/**
 * Agent result builders and extractors shared by gateway tests.
 */
type AgentDeltaEvent = {
  runId: string;
  stream: "assistant";
  data: { delta: string };
};

function extractCliStreamJsonText(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  let assistantText: string | null = null;
  let resultText: string | null = null;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type === "assistant") {
      const message =
        record.message && typeof record.message === "object"
          ? (record.message as Record<string, unknown>)
          : null;
      const content = Array.isArray(message?.content) ? message.content : [];
      const textParts = content
        .map((entry) =>
          entry && typeof entry === "object" ? (entry as Record<string, unknown>).text : undefined,
        )
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
      if (textParts.length > 0) {
        assistantText = textParts.join("\n").trim();
      }
      continue;
    }
    if (record.type === "result" && typeof record.result === "string" && record.result.trim()) {
      resultText = record.result.trim();
    }
  }

  return resultText ?? assistantText;
}

/** Extracts normalized assistant text from gateway agent result payloads. */
export function extractPayloadText(result: unknown): string {
  const record = result as Record<string, unknown>;
  const payloads = Array.isArray(record.payloads) ? record.payloads : [];
  const texts = payloads
    .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>).text : undefined))
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  const joined = texts.join("\n").trim();
  if (!joined) {
    return joined;
  }
  return extractCliStreamJsonText(joined) ?? joined;
}

/** Builds a minimal assistant delta result payload. */
export function buildAssistantDeltaResult(params: {
  opts: unknown;
  emit: (event: AgentDeltaEvent) => void;
  deltas: string[];
  text: string;
}): { payloads: Array<{ text: string }> } {
  const runId = (params.opts as { runId?: string } | undefined)?.runId ?? "";
  for (const delta of params.deltas) {
    params.emit({ runId, stream: "assistant", data: { delta } });
  }
  return { payloads: [{ text: params.text }] };
}
