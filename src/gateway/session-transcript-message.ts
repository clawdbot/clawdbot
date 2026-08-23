/** Attach OpenClaw metadata to a transcript message without dropping existing metadata. */
export function attachOpenClawTranscriptMeta(
  message: unknown,
  meta: Record<string, unknown>,
): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return message;
  }
  const record = message as Record<string, unknown>;
  const existing =
    record["__openclaw"] &&
    typeof record["__openclaw"] === "object" &&
    !Array.isArray(record["__openclaw"])
      ? (record["__openclaw"] as Record<string, unknown>)
      : {};
  return {
    ...record,
    __openclaw: {
      ...existing,
      ...meta,
    },
  };
}

function readTranscriptMessageIdempotencyKey(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const value = (message as Record<string, unknown>).idempotencyKey;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Project one stored transcript entry onto the client-visible chat history shape. */
export function projectTranscriptEntryMessage(entry: unknown, seq: number): unknown {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  if (record.message) {
    const recordTimestampMs =
      typeof record.timestamp === "string"
        ? Date.parse(record.timestamp)
        : typeof record.timestamp === "number"
          ? record.timestamp
          : Number.NaN;
    const idempotencyKey = readTranscriptMessageIdempotencyKey(record.message);
    return attachOpenClawTranscriptMeta(record.message, {
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(Number.isFinite(recordTimestampMs) ? { recordTimestampMs } : {}),
      seq,
    });
  }
  if (record.type !== "compaction" && record.type !== "reset") {
    return null;
  }
  const kind = record.type;
  const parsedTimestamp =
    typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  return {
    role: "system",
    content: [{ type: "text", text: kind === "compaction" ? "Compaction" : "Reset" }],
    timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now(),
    __openclaw: {
      kind,
      id: typeof record.id === "string" ? record.id : undefined,
      seq,
    },
  };
}
