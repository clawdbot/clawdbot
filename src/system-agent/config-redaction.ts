// System-agent config redaction keeps model-visible reads and plans aligned with config UI hints.
import {
  hasSensitiveUrlHintTag,
  isSensitiveUrlConfigPath,
  redactSensitiveUrlLikeString,
} from "@openclaw/net-policy/redact-sensitive-url";
import { parseConfigSetPath } from "../cli/config-cli-path.js";
import { REDACTED_SENTINEL, redactConfigObject } from "../config/redact-snapshot.js";
import { loadGatewayRuntimeConfigSchema } from "../config/runtime-schema.js";
import { buildConfigSchemaCore } from "../config/schema.js";
import { findWildcardHintMatch } from "../config/schema.shared.js";
import { isSensitiveConfigPath } from "../config/sensitive-paths.js";
import type { ConfigUiHint, ConfigUiHints } from "../shared/config-ui-hints-types.js";

function loadSystemAgentConfigUiHints(): ConfigUiHints {
  try {
    return loadGatewayRuntimeConfigSchema().uiHints;
  } catch {
    // Invalid config is a supported recovery state. Core hints plus the
    // redactor's path heuristics remain available without reloading that config.
    return {
      ...buildConfigSchemaCore().uiHints,
      "plugins.entries.*.config": { sensitive: true },
      "channels.*": { sensitive: true },
    };
  }
}

function splitConfigHintPath(path: string): string[] {
  // Schema hint paths use `[]` as an array wildcard; config writes spell the
  // same segment as `[*]`.
  return parseConfigSetPath(path.replace(/\[\]/g, "[*]"));
}

function resolveConfigUiHint(
  path: string,
  includeAncestors = false,
  acceptHint?: (hint: ConfigUiHint) => boolean,
): ConfigUiHint | undefined {
  return (
    findWildcardHintMatch({
      uiHints: loadSystemAgentConfigUiHints(),
      path,
      splitPath: splitConfigHintPath,
      includeAncestors,
      acceptHint,
    })?.hint ?? undefined
  );
}

/** Return whether a config value must stay out of model-visible command text. */
export function isSystemAgentSensitiveConfigValue(path: string, value: unknown): boolean {
  let canonicalPath: string;
  try {
    canonicalPath = parseConfigSetPath(path).join(".");
  } catch {
    // The command parser accepts a broader path surface than config writes do.
    // Keep malformed paths out of model-visible text instead of guessing how a
    // future writer or normalizer might interpret them.
    return true;
  }
  const sensitiveHint = resolveConfigUiHint(
    path,
    true,
    (candidate) => candidate.sensitive !== undefined,
  );
  if (sensitiveHint?.sensitive === true || isSensitiveConfigPath(canonicalPath)) {
    return true;
  }
  const hint = resolveConfigUiHint(path);
  return (
    typeof value === "string" &&
    (hasSensitiveUrlHintTag(hint) || isSensitiveUrlConfigPath(canonicalPath)) &&
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
  return replaceRedactionSentinels(redactConfigObject(value, loadSystemAgentConfigUiHints()));
}
