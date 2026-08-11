// System-agent config redaction keeps model-visible reads and plans aligned with config UI hints.
import {
  hasSensitiveUrlHintTag,
  isSensitiveUrlConfigPath,
  redactSensitiveUrlLikeString,
} from "@openclaw/net-policy/redact-sensitive-url";
import { REDACTED_SENTINEL, redactConfigObject } from "../config/redact-snapshot.js";
import { buildConfigSchemaCore } from "../config/schema.js";
import { findWildcardHintMatch } from "../config/schema.shared.js";
import { isSensitiveConfigPath } from "../config/sensitive-paths.js";
import type { ConfigUiHint } from "../shared/config-ui-hints-types.js";

function splitConfigPath(path: string): string[] {
  const normalized = path
    .trim()
    .replace(/\[(\*|\d*)\]/g, (_match, segment: string) => `.${segment || "*"}`)
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.+/g, ".");
  return normalized ? normalized.split(".").filter(Boolean) : [];
}

function resolveConfigUiHint(path: string): ConfigUiHint | undefined {
  return (
    findWildcardHintMatch({
      uiHints: buildConfigSchemaCore().uiHints,
      path,
      splitPath: splitConfigPath,
    })?.hint ?? undefined
  );
}

/** Return whether a config value must stay out of model-visible command text. */
export function isSystemAgentSensitiveConfigValue(path: string, value: unknown): boolean {
  const hint = resolveConfigUiHint(path);
  if (hint?.sensitive === true || isSensitiveConfigPath(path)) {
    return true;
  }
  return (
    typeof value === "string" &&
    (hasSensitiveUrlHintTag(hint) || isSensitiveUrlConfigPath(path)) &&
    redactSensitiveUrlLikeString(value) !== value
  );
}

function replaceRedactionSentinels(value: unknown): unknown {
  if (value === REDACTED_SENTINEL) {
    return "<redacted>";
  }
  if (Array.isArray(value)) {
    return value.map(replaceRedactionSentinels);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replaceRedactionSentinels(entry)]),
    );
  }
  return value;
}

/** Redact a config object before any subtree is projected into a model-visible result. */
export function redactSystemAgentConfig(value: unknown): unknown {
  return replaceRedactionSentinels(redactConfigObject(value, buildConfigSchemaCore().uiHints));
}
