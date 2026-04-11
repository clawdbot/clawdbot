import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import type { ConfigUiHint, ConfigUiHints } from "../types.ts";

export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  tags?: string[];
  "x-tags"?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: JsonSchema | boolean;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  nullable?: boolean;
};

export function schemaType(schema: JsonSchema): string | undefined {
  if (!schema) {
    return undefined;
  }
  if (Array.isArray(schema.type)) {
    return schema.type.find((t) => t !== "null") ?? schema.type[0];
  }
  return schema.type;
}

export function defaultValue(schema?: JsonSchema): unknown {
  if (!schema) {
    return "";
  }
  if (schema.default !== undefined) {
    return schema.default;
  }
  const type = schemaType(schema);
  switch (type) {
    case "object":
      return {};
    case "array":
      return [];
    case "boolean":
      return false;
    case "number":
    case "integer":
      return 0;
    case "string":
      return "";
    default:
      return "";
  }
}

export function pathKey(path: Array<string | number>): string {
  return path.filter((segment) => typeof segment === "string").join(".");
}

export function hintForPath(path: Array<string | number>, hints: ConfigUiHints) {
  const key = pathKey(path);
  const direct = hints[key];
  if (direct) {
    return direct;
  }
  const segments = key.split(".");
  for (const [hintKey, hint] of Object.entries(hints)) {
    if (!hintKey.includes("*")) {
      continue;
    }
    const hintSegments = hintKey.split(".");
    if (hintSegments.length !== segments.length) {
      continue;
    }
    let match = true;
    for (let i = 0; i < segments.length; i += 1) {
      if (hintSegments[i] !== "*" && hintSegments[i] !== segments[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      return hint;
    }
  }
  return undefined;
}

export function humanize(raw: string) {
  return raw
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .replace(/^./, (m) => m.toUpperCase());
}

const SENSITIVE_KEY_WHITELIST_SUFFIXES = [
  "maxtokens",
  "maxoutputtokens",
  "maxinputtokens",
  "maxcompletiontokens",
  "contexttokens",
  "totaltokens",
  "tokencount",
  "tokenlimit",
  "tokenbudget",
  "passwordfile",
] as const;

const SENSITIVE_PATTERNS = [
  /token$/i,
  /password/i,
  /secret/i,
  /api.?key/i,
  /serviceaccount(?:ref)?$/i,
];

const ENV_VAR_PLACEHOLDER_PATTERN = /^\$\{[^}]*\}$/;

export const REDACTED_PLACEHOLDER = "[redacted - click reveal to view]";

function isEnvVarPlaceholder(value: string): boolean {
  return ENV_VAR_PLACEHOLDER_PATTERN.test(value.trim());
}

export function isSensitiveConfigPath(path: string): boolean {
  const lowerPath = normalizeLowercaseStringOrEmpty(path);
  const whitelisted = SENSITIVE_KEY_WHITELIST_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix));
  return !whitelisted && SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));
}

function isSensitiveLeafValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0 && !isEnvVarPlaceholder(value);
  }
  return value !== undefined && value !== null;
}

function isHintSensitive(hint: ConfigUiHint | undefined): boolean {
  return hint?.sensitive ?? false;
}

export function hasSensitiveConfigData(
  value: unknown,
  path: Array<string | number>,
  hints: ConfigUiHints,
): boolean {
  const key = pathKey(path);
  const hint = hintForPath(path, hints);
  const pathIsSensitive = isHintSensitive(hint) || isSensitiveConfigPath(key);

  if (pathIsSensitive && isSensitiveLeafValue(value)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((item, index) => hasSensitiveConfigData(item, [...path, index], hints));
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([childKey, childValue]) =>
      hasSensitiveConfigData(childValue, [...path, childKey], hints),
    );
  }

  return false;
}

export function countSensitiveConfigValues(
  value: unknown,
  path: Array<string | number>,
  hints: ConfigUiHints,
): number {
  if (value == null) {
    return 0;
  }

  const key = pathKey(path);
  const hint = hintForPath(path, hints);
  const pathIsSensitive = isHintSensitive(hint) || isSensitiveConfigPath(key);

  if (pathIsSensitive && isSensitiveLeafValue(value)) {
    return 1;
  }

  if (Array.isArray(value)) {
    return value.reduce(
      (count, item, index) => count + countSensitiveConfigValues(item, [...path, index], hints),
      0,
    );
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce(
      (count, [childKey, childValue]) =>
        count + countSensitiveConfigValues(childValue, [...path, childKey], hints),
      0,
    );
  }

  return 0;
}
