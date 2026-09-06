import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export function isVisibleTranscriptRecord(value: unknown): value is Record<string, unknown> {
  const record = asOptionalRecord(value);
  return Boolean(record?.message) || record?.type === "compaction" || record?.type === "reset";
}
