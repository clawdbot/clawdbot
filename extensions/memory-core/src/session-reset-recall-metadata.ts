export type SessionResetRecallCutoff =
  | { state: "absent" }
  | { state: "invalid" }
  | { cutoffLine: number; state: "valid" };

const RESET_RECALL_CUTOFF = Symbol.for("openclaw.memory.sessionResetRecallCutoff");

export function readSessionResetRecallCutoffMetadata(value: unknown): SessionResetRecallCutoff {
  if (!value || typeof value !== "object") {
    return { state: "invalid" };
  }
  const cutoff = (value as Record<PropertyKey, unknown>)[RESET_RECALL_CUTOFF];
  if (!cutoff || typeof cutoff !== "object") {
    return { state: "invalid" };
  }
  const state = (cutoff as { state?: unknown }).state;
  if (state === "absent" || state === "invalid") {
    return { state };
  }
  const cutoffLine = (cutoff as { cutoffLine?: unknown }).cutoffLine;
  return state === "valid" && typeof cutoffLine === "number" && Number.isInteger(cutoffLine)
    ? { state, cutoffLine }
    : { state: "invalid" };
}

export function readSessionArchiveReasonFromHitPath(
  hitPath: string,
): "reset" | "deleted" | undefined {
  const match =
    /\.jsonl\.(reset|deleted)\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z(?:\.zst)?$/.exec(
      hitPath,
    );
  const reason = match?.[1];
  return reason === "reset" || reason === "deleted" ? reason : undefined;
}
