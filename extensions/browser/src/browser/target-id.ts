/**
 * Target id resolution helpers for Browser tab aliases and user-facing ids.
 */
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Result for resolving a user-supplied tab id, label, or target prefix. */
type TargetIdResolution =
  | { ok: true; targetId: string }
  | { ok: false; reason: "not_found" | "ambiguous"; matches?: string[] };

/** Resolves exact tab references first, then unique raw target-id prefixes. */
export function resolveTargetIdFromTabs(
  input: string,
  tabs: Array<{ targetId: string; suggestedTargetId?: string; tabId?: string; label?: string }>,
): TargetIdResolution {
  const needle = input.trim();
  if (!needle) {
    return { ok: false, reason: "not_found" };
  }

  // Friendly references and raw CDP ids share one input field, so a cross-namespace
  // collision must fail closed instead of silently choosing a different tab.
  const exactMatches = [
    ...new Set(
      tabs
        .filter(
          (tab) =>
            tab.targetId === needle ||
            tab.suggestedTargetId === needle ||
            tab.tabId === needle ||
            tab.label === needle,
        )
        .map((tab) => tab.targetId),
    ),
  ];
  const onlyExact = exactMatches[0];
  if (exactMatches.length === 1 && onlyExact !== undefined) {
    return { ok: true, targetId: onlyExact };
  }
  if (exactMatches.length > 1) {
    return { ok: false, reason: "ambiguous", matches: exactMatches };
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
