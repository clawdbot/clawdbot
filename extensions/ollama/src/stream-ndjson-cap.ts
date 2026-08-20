// Ollama's Go client caps one streamed line at 8 MB. Keep more than a 2x
// compatibility margin while preventing newline-free peers from growing memory.
const OLLAMA_NDJSON_RECORD_MAX_BYTES = 16 * 1024 * 1024;

export function checkNdjsonRecordCap(value: Uint8Array, pendingRecordBytes: number): number {
  let offset = 0;
  let pending = pendingRecordBytes;
  while (offset < value.byteLength) {
    const newlineIndex = value.indexOf(0x0a, offset);
    const segmentEnd = newlineIndex === -1 ? value.byteLength : newlineIndex;
    pending += segmentEnd - offset;
    if (pending > OLLAMA_NDJSON_RECORD_MAX_BYTES) {
      throw new Error(`Ollama NDJSON record exceeds ${OLLAMA_NDJSON_RECORD_MAX_BYTES} bytes`);
    }
    if (newlineIndex === -1) {
      break;
    }
    pending = 0;
    offset = newlineIndex + 1;
  }
  return pending;
}
