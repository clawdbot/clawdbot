// Fenced MEDIA: operator warn after accepted outbound delivery (#41966).
import { logWarn } from "../../logger.js";
import { splitMediaFromOutput } from "../../media/parse.js";

const FENCED_MEDIA_SKIP_WARN =
  "media: MEDIA: token skipped — it is inside a fenced code block and will not be delivered as media. " +
  "Fenced MEDIA lines stay visible text by design; delivery of legacy MEDIA: depends on the outbound path " +
  "(some direct channel paths keep unfenced MEDIA: as literal text too).";

/** True when final payload text still contains a fenced MEDIA: line (#41966). */
function textHasFencedMediaTokenSkip(text: string | undefined): boolean {
  if (!text || !/media:/i.test(text)) {
    return false;
  }
  let skipped = false;
  splitMediaFromOutput(text, {
    onFencedMediaTokenSkipped: () => {
      skipped = true;
    },
  });
  return skipped;
}

/**
 * True when final accepted text still retains the exact skipped directive
 * identity (trimmed line), not merely any `media:` substring (#41966).
 */
function textRetainsFencedSkippedMediaDirective(
  text: string | undefined,
  directive: string | undefined,
): boolean {
  if (!text || !directive) {
    return false;
  }
  const identity = directive.trim();
  if (!identity) {
    return false;
  }
  // Match whole lines after trim so hook prose like "For media: see docs" and a
  // different unfenced MEDIA: line cannot falsely keep the original identity.
  for (const line of text.split("\n")) {
    if (line.trim() === identity) {
      return true;
    }
  }
  return false;
}

/**
 * Emit one operator warning per accepted delivery entry that was planned with a
 * fenced MEDIA skip and whose *final* accepted text still retains that exact
 * skipped directive identity. Carry plan identities by sourceIndex so channel
 * sanitizers that flatten Markdown fences (SMS/plain-text) cannot erase the
 * diagnostic, while hook rewrites that remove/replace the directive suppress
 * the warn (#41966).
 *
 * Call only after a confirmed physical/visible send outcome (durable core or
 * direct channel paths) — not during preparation or pre-accept planning.
 * Plan facts may be reconstructed from durable prepared-batch custody on recovery.
 */
export function warnFencedMediaSkipsForAcceptedOutboundDelivery(
  entries: readonly {
    text?: string;
    mediaTokenSkippedInFence?: boolean;
    fencedSkippedMediaDirectives?: readonly string[];
  }[],
): void {
  for (const entry of entries) {
    const identities = entry.fencedSkippedMediaDirectives ?? [];
    // Prefer exact directive identity. Boolean-only callers fall back to a
    // still-fenced MEDIA line check (not a bare media: substring).
    const retained =
      identities.length > 0
        ? identities.some((directive) =>
            textRetainsFencedSkippedMediaDirective(entry.text, directive),
          )
        : Boolean(entry.mediaTokenSkippedInFence) && textHasFencedMediaTokenSkip(entry.text);
    if (retained) {
      logWarn(FENCED_MEDIA_SKIP_WARN);
    }
  }
}
