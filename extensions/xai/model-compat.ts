// Xai plugin module implements model compat behavior.
import {
  applyModelCompatPatch,
  type ModelCompatConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

export { normalizeXaiModelId as normalizeNativeXaiModelId } from "./model-id.js";

export const XAI_TOOL_SCHEMA_PROFILE = "xai";
export const HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING = "html-entities";

// Native xAI accepts common length/item bounds; only contains-count bounds remain
// outside its documented schema contract. Proxy providers own stricter downstream policy.
const XAI_UNSUPPORTED_SCHEMA_KEYWORDS = new Set(["minContains", "maxContains"]);

function resolveXaiModelCompatPatch(): ModelCompatConfig {
  return {
    toolSchemaProfile: XAI_TOOL_SCHEMA_PROFILE,
    unsupportedToolSchemaKeywords: Array.from(XAI_UNSUPPORTED_SCHEMA_KEYWORDS),
    nativeWebSearchTool: true,
    toolCallArgumentsEncoding: HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING,
  };
}

export function applyXaiModelCompat<T extends { compat?: unknown }>(model: T): T {
  return applyModelCompatPatch(
    model as T & { compat?: ModelCompatConfig },
    resolveXaiModelCompatPatch(),
  ) as T;
}
