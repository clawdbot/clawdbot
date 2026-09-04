// Provides shared JSON schema helpers for generated config metadata.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConfigSchemaResponse as ProtocolConfigSchemaResponse } from "../../packages/gateway-protocol/src/schema/config.js";
import type { ConfigUiHints } from "../shared/config-ui-hints-types.js";

export type ConfigSchemaResponse = Omit<ProtocolConfigSchemaResponse, "schema" | "uiHints"> & {
  schema: Record<string, unknown>;
  uiHints: ConfigUiHints;
};

export type ConfigJsonSchemaObject = Record<string, unknown> & {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, ConfigJsonSchemaObject>;
  required?: string[];
  additionalProperties?: ConfigJsonSchemaObject | boolean;
  propertyNames?: ConfigJsonSchemaObject | boolean;
  items?: ConfigJsonSchemaObject | ConfigJsonSchemaObject[];
  anyOf?: ConfigJsonSchemaObject[];
  allOf?: ConfigJsonSchemaObject[];
  oneOf?: ConfigJsonSchemaObject[];
};

/** Deep-clone schema payloads before callers mutate plugin or base schema fragments. */
export function cloneSchema<T>(value: T): T {
  return structuredClone(value);
}

/** Narrow unknown JSON-schema fragments to non-array objects. */
export function asSchemaObject(value: unknown): ConfigJsonSchemaObject | null {
  return asNullableRecord(value);
}

/** Return whether a schema node exposes nested fields through properties, items, or unions. */
export function schemaHasChildren(schema: ConfigJsonSchemaObject): boolean {
  if (schema.properties && Object.keys(schema.properties).length > 0) {
    return true;
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    return true;
  }
  if (Array.isArray(schema.items)) {
    return schema.items.some((entry) => typeof entry === "object" && entry !== null);
  }
  for (const branch of [schema.oneOf, schema.anyOf, schema.allOf]) {
    if (branch?.some((entry) => entry && typeof entry === "object" && schemaHasChildren(entry))) {
      return true;
    }
  }
  return Boolean(schema.items && typeof schema.items === "object");
}

/** Find the most specific wildcard UI hint that matches a concrete config path. */
export function findWildcardHintMatch<T>(params: {
  uiHints: Record<string, T>;
  path: string;
  targetParts?: readonly string[];
  splitPath: (path: string) => string[];
  includeAncestors?: boolean;
  acceptHint?: (hint: T) => boolean;
}): { path: string; hint: T } | null {
  const targetParts = params.targetParts ?? params.splitPath(params.path);
  let bestMatch:
    | {
        path: string;
        hint: T;
        partCount: number;
        wildcardCount: number;
      }
    | undefined;

  for (const [hintPath, hint] of Object.entries(params.uiHints)) {
    if (params.acceptHint && !params.acceptHint(hint)) {
      continue;
    }
    const hintParts = params.splitPath(hintPath);
    if (
      hintParts.length > targetParts.length ||
      (!params.includeAncestors && hintParts.length !== targetParts.length)
    ) {
      continue;
    }

    let wildcardCount = 0;
    let matches = true;
    for (let index = 0; index < hintParts.length; index += 1) {
      const hintPart = hintParts[index];
      const targetPart = targetParts[index];
      if (hintPart === targetPart) {
        continue;
      }
      if (hintPart === "*") {
        wildcardCount += 1;
        continue;
      }
      matches = false;
      break;
    }

    if (!matches) {
      continue;
    }
    // The deepest hint lets an explicit child override an inherited sensitive parent;
    // choosing the parent instead could either leak the child or over-redact it.
    if (
      !bestMatch ||
      hintParts.length > bestMatch.partCount ||
      (hintParts.length === bestMatch.partCount && wildcardCount < bestMatch.wildcardCount)
    ) {
      bestMatch = { path: hintPath, hint, partCount: hintParts.length, wildcardCount };
    }
  }

  return bestMatch ? { path: bestMatch.path, hint: bestMatch.hint } : null;
}
