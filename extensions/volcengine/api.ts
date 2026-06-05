// Volcengine API module exposes the plugin public contract.
import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

export const VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS = [
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minContains",
  "maxContains",
] as const;

function mergeUnsupportedToolSchemaKeywords(existing: readonly string[] | undefined): string[] {
  return uniqueStrings([...(existing ?? []), ...VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS]);
}

export function resolveVolcengineToolSchemaCompatPatch(
  compat?: ModelCompatConfig,
): ModelCompatConfig {
  return {
    unsupportedToolSchemaKeywords: mergeUnsupportedToolSchemaKeywords(
      compat?.unsupportedToolSchemaKeywords,
    ),
  };
}

export function applyVolcengineToolSchemaCompat<T extends { compat?: ModelCompatConfig }>(
  model: T,
): T {
  const unsupportedToolSchemaKeywords = mergeUnsupportedToolSchemaKeywords(
    model.compat?.unsupportedToolSchemaKeywords,
  );
  if (
    model.compat?.unsupportedToolSchemaKeywords?.length === unsupportedToolSchemaKeywords.length &&
    unsupportedToolSchemaKeywords.every(
      (keyword, index) => model.compat?.unsupportedToolSchemaKeywords?.[index] === keyword,
    )
  ) {
    return model;
  }
  return {
    ...model,
    compat: {
      ...model.compat,
      unsupportedToolSchemaKeywords,
    },
  };
}

export { buildDoubaoCodingProvider, buildDoubaoProvider } from "./provider-catalog.js";
export {
  buildDoubaoModelDefinition,
  DOUBAO_BASE_URL,
  DOUBAO_CODING_BASE_URL,
  DOUBAO_CODING_MODEL_CATALOG,
  DOUBAO_MODEL_CATALOG,
} from "./models.js";
