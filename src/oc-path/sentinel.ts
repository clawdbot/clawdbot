/**
 * Substrate-level redaction-sentinel guard.
 *
 * Closes the `__OPENCLAW_REDACTED__` corruption class by rejecting the
 * literal string at the emit boundary. Per-call-site reject rules
 * (added piecemeal in [#62281](https://github.com/openclaw/openclaw/issues/62281),
 * [#44357](https://github.com/openclaw/openclaw/issues/44357),
 * [#13495](https://github.com/openclaw/openclaw/issues/13495), and others)
 * caught the symptom; this guard removes the substrate that produced
 * the symptom in the first place.
 *
 * Throwing at emit (not at the consumer) means every code path through
 * the substrate is covered, including future call sites we haven't
 * audited.
 *
 * @module @openclaw/oc-path/sentinel
 */

/**
 * The literal string that marks redacted secrets in OpenClaw's runtime
 * representation. Writing it to disk is always a bug — the consumer
 * was supposed to drop the redacted view, not pass it through to the
 * writer.
 */
export const REDACTED_SENTINEL = '__OPENCLAW_REDACTED__';

/**
 * Thrown when emit detects a `"__OPENCLAW_REDACTED__"` literal in any
 * emitted bytes. Callers should treat this as a fatal write error;
 * recovering by stripping the sentinel would silently corrupt the
 * file. Fail-closed.
 *
 * `path` is the OcPath-shaped pointer to where the sentinel was
 * detected (e.g., `oc://config/plugins.entries.foo.token`). For
 * non-config emits, it's the closest meaningful address (frontmatter
 * key, section/item slug, etc.) or just the file name.
 */
export class OcEmitSentinelError extends Error {
  readonly code = 'OC_EMIT_SENTINEL';
  readonly path: string;

  constructor(path: string) {
    super(`emit refused to write "${REDACTED_SENTINEL}" sentinel literal at ${path}`);
    this.name = 'OcEmitSentinelError';
    this.path = path;
  }
}

/**
 * Throw `OcEmitSentinelError` if `value` contains the redaction
 * sentinel anywhere. Substring match (not equality) — a hostile caller
 * embedding `prefix__OPENCLAW_REDACTED__suffix` in a leaf must be
 * rejected just as forcefully as the bare sentinel; the substring form
 * still leaks the marker bytes to disk where downstream scanners flag
 * the file as corrupted.
 *
 * No-op for any non-string input. Used by every leaf-write boundary.
 */
export function guardSentinel(value: unknown, ocPath: string): void {
  if (typeof value === 'string' && value.includes(REDACTED_SENTINEL)) {
    throw new OcEmitSentinelError(ocPath);
  }
}
