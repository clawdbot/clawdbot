import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

export function nativeHistoryMessageIdentity(message: unknown): string | null {
  const record = asNullableRecord(message);
  const metadata = asNullableRecord(record?.["__openclaw"]);
  const seq = metadata?.seq;
  const id = metadata?.id ?? record?.messageId;
  const sourceIdentity =
    typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0
      ? `seq:${seq}`
      : typeof id === "string" && id.trim()
        ? `id:${id}`
        : null;
  if (!sourceIdentity) {
    return null;
  }
  const { recordTimestampMs: _recordTimestampMs, ...projectionMetadata } = metadata ?? {};
  const projection = metadata ? { ...record, __openclaw: projectionMetadata } : record;
  try {
    // History alone adds recordTimestampMs; delivery metadata is not projection identity.
    // Keep every other projection byte so siblings from one transcript row stay distinct.
    return `${sourceIdentity}:${JSON.stringify(projection)}`;
  } catch {
    return sourceIdentity;
  }
}
