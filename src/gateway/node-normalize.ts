/** Normalize optional string-ish websocket fields. Leaf module (no gateway imports). */
export function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
