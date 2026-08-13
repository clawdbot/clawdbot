// System-agent config redaction keeps model-visible reads and plans aligned with config UI hints.
import {
  hasSensitiveUrlHintTag,
  isSensitiveUrlConfigPath,
  redactSensitiveUrlLikeString,
} from "@openclaw/net-policy/redact-sensitive-url";
import { parseConfigSetPath, parseConfigSetValue } from "../cli/config-cli-path.js";
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
  path: readonly string[],
  uiHints: ConfigUiHints,
  includeAncestors = false,
  acceptHint?: (hint: ConfigUiHint) => boolean,
): ConfigUiHint | undefined {
  return (
    findWildcardHintMatch({
      uiHints,
      path: path.join("."),
      // Config path segments can themselves contain dots. Preserve the
      // writer-parsed boundaries instead of reparsing a lossy joined path.
      targetParts: path,
      splitPath: splitConfigHintPath,
      includeAncestors,
      acceptHint,
    })?.hint ?? undefined
  );
}

function hasSensitiveConfigValue(path: string[], value: unknown, uiHints: ConfigUiHints): boolean {
  const canonicalPath = path.join(".");
  const sensitiveHint = resolveConfigUiHint(
    path,
    uiHints,
    true,
    (candidate) => candidate.sensitive !== undefined,
  );
  if (sensitiveHint?.sensitive === true || isSensitiveConfigPath(canonicalPath)) {
    return true;
  }
  const hint = resolveConfigUiHint(path, uiHints);
  if (
    typeof value === "string" &&
    (hasSensitiveUrlHintTag(hint) || isSensitiveUrlConfigPath(canonicalPath)) &&
    redactSensitiveUrlLikeString(value) !== value
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((entry, index) =>
      hasSensitiveConfigValue([...path, String(index)], entry, uiHints),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, entry]) =>
      hasSensitiveConfigValue([...path, key], entry, uiHints),
    );
  }
  return false;
}

/** Return whether a config value must stay out of model-visible command text. */
export function isSystemAgentSensitiveConfigValue(path: string, value: unknown): boolean {
  let parsedPath: string[];
  try {
    parsedPath = parseConfigSetPath(path);
  } catch {
    // The command parser accepts a broader path surface than config writes do.
    // Keep malformed paths out of model-visible text instead of guessing how a
    // future writer or normalizer might interpret them.
    return true;
  }
  const parsedValue = typeof value === "string" ? parseConfigSetValue(value, false) : value;
  return hasSensitiveConfigValue(parsedPath, parsedValue, loadSystemAgentConfigUiHints());
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
