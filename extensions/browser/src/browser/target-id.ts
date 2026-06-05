/**
 * Target id resolution helpers for Browser tab aliases and user-facing ids.
 */
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Result for resolving a user-supplied tab id, label, or target prefix. */
type TargetIdResolution =
  | { ok: true; targetId: string }
  | { ok: false; reason: "not_found" | "ambiguous"; matches?: string[] };

/** Resolves exact tab ids/labels first, then unique target-id prefixes. */
export function resolveTargetIdFromTabs(
  input: string,
  tabs: Array<{ targetId: string; suggestedTargetId?: string; tabId?: string; label?: string }>,
): TargetIdResolution {
  const needle = input.trim();
  if (!needle) {
    return { ok: false, reason: "not_found" };
  }

  const exact = tabs.find(
    (t) =>
      t.targetId === needle ||
      t.suggestedTargetId === needle ||
      t.tabId === needle ||
      t.label === needle,
  );
  if (exact) {
    return { ok: true, targetId: exact.targetId };
  }

  const lower = normalizeLowercaseStringOrEmpty(needle);
  const matches = tabs
    .map((t) => t.targetId)
    .filter((id) => normalizeLowercaseStringOrEmpty(id).startsWith(lower));

  const only = matches.length === 1 ? matches[0] : undefined;
  if (only) {
    return { ok: true, targetId: only };
  }
  if (matches.length === 0) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: false, reason: "ambiguous", matches };
}
