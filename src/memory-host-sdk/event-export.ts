import type { PersistedMemoryHostEvent } from "./event-store.js";

export const MAX_MEMORY_HOST_PUBLIC_EXPORT_BYTES = 1024 * 1024;

export function serializeMemoryHostEventExport(
  storedEvents: readonly PersistedMemoryHostEvent[],
): string {
  const lines: string[] = [];
  let sizeBytes = 0;
  for (const entry of storedEvents.toReversed()) {
    const line = JSON.stringify(entry.value.event);
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (sizeBytes + lineBytes > MAX_MEMORY_HOST_PUBLIC_EXPORT_BYTES) {
      break;
    }
    lines.push(line);
    sizeBytes += lineBytes;
  }
  return lines.toReversed().join("\n") + "\n";
}
