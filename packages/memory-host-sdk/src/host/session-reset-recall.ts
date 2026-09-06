type SessionResetRecallCutoff =
  | { state: "absent" }
  | { state: "invalid" }
  | { cutoffLine: number; state: "valid" };

function eventId(event: unknown): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const id = (event as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : undefined;
}

/** Resolves the first raw transcript line owned by the current reset generation. */
export function resolveSessionResetRecallCutoff(
  events: readonly unknown[],
): SessionResetRecallCutoff {
  const resetIndex = events.findLastIndex(
    (event) =>
      event !== null &&
      typeof event === "object" &&
      !Array.isArray(event) &&
      (event as { type?: unknown }).type === "reset",
  );
  if (resetIndex < 0) {
    return { state: "absent" };
  }
  const reset = events[resetIndex] as { firstKeptEntryId?: unknown };
  if (reset.firstKeptEntryId === undefined) {
    return { state: "valid", cutoffLine: resetIndex + 1 };
  }
  if (typeof reset.firstKeptEntryId !== "string" || !reset.firstKeptEntryId.trim()) {
    return { state: "invalid" };
  }
  const keptIndex = events.findIndex(
    (event, index) => index < resetIndex && eventId(event) === reset.firstKeptEntryId,
  );
  return keptIndex < 0 ? { state: "invalid" } : { state: "valid", cutoffLine: keptIndex + 1 };
}
