import { isSensitiveConfigPath } from "../../../src/config/sensitive-paths.js";
import type { ConfigUiHint, ConfigUiHints } from "../api/types.ts";
// Control UI view renders config form.shared screen content.
import { t } from "../i18n/index.ts";

export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  tags?: string[];
  "x-tags"?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  additionalItems?: JsonSchema | boolean;
  additionalProperties?: JsonSchema | boolean;
  enum?: unknown[];
  enumIncludesNull?: boolean;
  const?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
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
    return schema.type.find((type) => type !== "null") ?? schema.type[0];
  }
  return schema.type;
}

export function configFieldId(path: Array<string | number>, suffix: string): string {
  const key =
    path.length === 0
      ? "root"
      : path
          .map((segment) => {
            const value = String(segment);
            let encoded = "";
            for (let index = 0; index < value.length; index += 1) {
              encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
            }
            const type = typeof segment === "number" ? "n" : "s";
            return `${type}${value.length}-${encoded}`;
          })
          .join("_");
  return `config-field-${key}-${suffix}`;
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
  const segments = path.map(String);
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

const ENV_VAR_PLACEHOLDER_PATTERN = /^\$\{[^}]*\}$/;

export function redactedPlaceholder(): string {
  return t("configForm.redactedPlaceholder");
}

const MAX_SENSITIVE_SCAN_DEPTH = 64;
const MAX_SENSITIVE_SCAN_NODES = 20_000;

type SensitiveScanState = {
  visited: number;
};

function createSensitiveScanState(): SensitiveScanState {
  return { visited: 0 };
}

function enterSensitiveScanNode(state: SensitiveScanState, depth: number): boolean {
  if (depth > MAX_SENSITIVE_SCAN_DEPTH) {
    return false;
  }
  state.visited += 1;
  if (state.visited > MAX_SENSITIVE_SCAN_NODES) {
    return false;
  }
  return true;
}

function isEnvVarPlaceholder(value: string): boolean {
  return ENV_VAR_PLACEHOLDER_PATTERN.test(value.trim());
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
  return hasSensitiveConfigDataInner(value, path, hints, createSensitiveScanState(), 0);
}

function hasSensitiveConfigDataInner(
  value: unknown,
  path: Array<string | number>,
  hints: ConfigUiHints,
  scan: SensitiveScanState,
  depth: number,
): boolean {
  if (!enterSensitiveScanNode(scan, depth)) {
    return true;
  }

  const key = pathKey(path);
  const hint = hintForPath(path, hints);
  const pathIsSensitive = isHintSensitive(hint) || isSensitiveConfigPath(key);

  if (pathIsSensitive && isSensitiveLeafValue(value)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((item, index) =>
      hasSensitiveConfigDataInner(item, [...path, index], hints, scan, depth + 1),
    );
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([childKey, childValue]) =>
      hasSensitiveConfigDataInner(childValue, [...path, childKey], hints, scan, depth + 1),
    );
  }

  return false;
}

export function countSensitiveConfigValues(
  value: unknown,
  path: Array<string | number>,
  hints: ConfigUiHints,
): number {
  return countSensitiveConfigValuesInner(value, path, hints, createSensitiveScanState(), 0);
}

function countSensitiveConfigValuesInner(
  value: unknown,
  path: Array<string | number>,
  hints: ConfigUiHints,
  scan: SensitiveScanState,
  depth: number,
): number {
  if (!enterSensitiveScanNode(scan, depth)) {
    return 1;
  }

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
      (count, item, index) =>
        count + countSensitiveConfigValuesInner(item, [...path, index], hints, scan, depth + 1),
      0,
    );
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce(
      (count, [childKey, childValue]) =>
        count +
        countSensitiveConfigValuesInner(childValue, [...path, childKey], hints, scan, depth + 1),
      0,
    );
  }

  return 0;
}
