import { isRecord } from "@openclaw/normalization-core/record-coerce";

const JSON_SCHEMA_RESPONSE_FORMAT_NAME = "openclaw_response";
const OLLAMA_CLOUD_ORIGIN = "https://ollama.com";

export function isKnownOpenAIJsonSchemaModelId(modelId: string | undefined): boolean {
  if (typeof modelId !== "string") {
    return false;
  }
  if (/^gpt-5(?:[.-]|$)/i.test(modelId) || /^gpt-4\.1(?:-|$)/i.test(modelId)) {
    return true;
  }
  const gpt4o = /^gpt-4o(-mini)?(?:-(\d{4}-\d{2}-\d{2}))?$/i.exec(modelId);
  if (gpt4o) {
    const snapshot = gpt4o[2];
    return !snapshot || snapshot >= (gpt4o[1] ? "2024-07-18" : "2024-08-06");
  }
  return /^(?:o1|o3(?:-mini|-pro)?|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/i.test(modelId);
}

export function shouldOmitOllamaCompatResponseFormat(params: {
  provider: string;
  baseUrl: string;
  hasTools: () => boolean;
}): boolean {
  if (!params.provider.includes("ollama")) {
    return false;
  }
  if (params.hasTools()) {
    return true;
  }
  try {
    return new URL(params.baseUrl).origin === OLLAMA_CLOUD_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Maps the shared JSON Schema option to Chat Completions while preserving the
 * older provider-shaped json_object/json_schema inputs accepted by model params.
 */
export function resolveOpenAICompletionsResponseFormat(
  responseFormat: Record<string, unknown> | undefined,
  supportsJsonSchemaResponseFormat: boolean,
): Record<string, unknown> | undefined {
  if (!responseFormat) {
    return undefined;
  }
  if (responseFormat.type === "json_object") {
    return responseFormat;
  }
  if (responseFormat.type === "text") {
    return responseFormat;
  }
  if (responseFormat.type === "json_schema" && isRecord(responseFormat.json_schema)) {
    return responseFormat;
  }
  if (!supportsJsonSchemaResponseFormat) {
    return undefined;
  }
  return {
    type: "json_schema",
    json_schema: {
      name: JSON_SCHEMA_RESPONSE_FORMAT_NAME,
      schema: responseFormat,
    },
  };
}
