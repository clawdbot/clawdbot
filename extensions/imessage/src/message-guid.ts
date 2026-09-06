/** Strip the `p:<n>/` part prefix Messages puts on some GUIDs so keys match. */
export function normalizeIMessageGuid(value: string): string {
  return value.trim().replace(/^p:\d+\//iu, "");
}
