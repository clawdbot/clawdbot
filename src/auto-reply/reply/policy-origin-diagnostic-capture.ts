/**
 * Test-controlled, env-gated diagnostic capture for source-reply policy
 * origin tracing (OpenClaw #129635 evidence probe). Off by default.
 *
 * MUST NOT capture prompts, message text, destination/target data,
 * session/run IDs, credentials, provider payloads, paths, raw error
 * strings, or token data. Only fixed enums/booleans are allowed.
 *
 * Runtime schema: every field in the persisted event must appear in
 * ALLOWED_FIELDS and pass the per-field type guard. Unknown or
 * non-conforming fields are silently omitted before persistence.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

const CAPTURE_ENV_VAR = "OPENCLAW_SOURCE_REPLY_POLICY_CAPTURE_PATH";

/**
 * Exhaustive set of call-site point identifiers that may be persisted.
 * point is an untrusted delivery field: any value not in this set is
 * silently dropped before persistence so arbitrary strings cannot reach
 * the diagnostic artifact.
 */
const ALLOWED_POINTS = new Set<string>([
  "followup-delivery.decision",
  "followup-delivery.source-policy-resolved",
  "get-reply-run-context.resolved-modes",
]);

/**
 * Exhaustive set of field names that may be persisted.
 * Any field not listed here is rejected at runtime.
 */
const ALLOWED_FIELDS = new Set<string>([
  // followup-delivery call sites
  "queuedEffectiveMode",
  "sendPolicy",
  "finalSuppressionCategory",
  "sessionStableMode",
  // get-reply-run-context call site
  "directAgentRequestedMode",
  "sessionStableModeSource",
  "isSyntheticTurn",
]);

/**
 * Allowed string enum values per field name.
 * A field whose value is not in its allow-set is omitted.
 * Fields mapped to null accept any string value (for forward-compat enums)
 * but still require a string type.
 */
const ALLOWED_STRING_VALUES: Record<string, ReadonlySet<string> | null> = {
  sendPolicy: new Set(["allow", "deny"]),
  finalSuppressionCategory: new Set(["none", "send-policy", "message-tool-only", "silent"]),
  sessionStableModeSource: new Set(["injected", "resolved-session-entry", "same-as-requested"]),
};

/** Accept booleans as-is; accept null (nullable enum fields). */
function isSafeValue(field: string, value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (typeof value === "boolean") {
    return true;
  }
  if (typeof value === "string") {
    const allowed = ALLOWED_STRING_VALUES[field];
    if (allowed === undefined) {
      // Field in ALLOWED_FIELDS but no value constraint: accept any string.
      return true;
    }
    if (allowed === null) {
      return true;
    }
    return allowed.has(value);
  }
  // numbers, objects, arrays, undefined: reject
  return false;
}

/**
 * Strip any field that is not in the allowlist or fails the value guard.
 * Returns a new object safe for persistence.
 */
function sanitize(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (ALLOWED_FIELDS.has(k) && isSafeValue(k, v)) {
      out[k] = v;
    }
  }
  return out;
}

export function capturePolicyOrigin(point: string, data: Record<string, unknown>): void {
  const capturePath = process.env[CAPTURE_ENV_VAR];
  if (!capturePath) {
    return;
  }
  // Treat point as an untrusted delivery field: drop silently if not allowlisted.
  if (!ALLOWED_POINTS.has(point)) {
    return;
  }
  try {
    const safeData = sanitize(data);
    mkdirSync(nodePath.dirname(capturePath), { recursive: true });
    const existing = existsSync(capturePath)
      ? (JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, unknown>)
      : {};
    const events = Array.isArray(existing.events) ? existing.events : [];
    writeFileSync(
      capturePath,
      JSON.stringify(
        {
          ...existing,
          schemaVersion: 1,
          events: [...events, { seq: events.length + 1, point, ...safeData }],
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // Diagnostic capture must never break production paths.
  }
}
