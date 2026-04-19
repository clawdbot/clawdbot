import { readStringValue } from "../shared/string-coerce.js";
import { normalizeToolParameterSchema } from "./pi-tools.schema.js";
import { resolveProviderRequestCapabilities } from "./provider-attribution.js";

type OpenAITransportKind = "stream" | "websocket";

type OpenAIStrictToolModel = {
  provider?: unknown;
  api?: unknown;
  baseUrl?: unknown;
  id?: unknown;
  compat?: { supportsStore?: boolean };
};

type ToolWithParameters = {
  parameters: unknown;
};

const optionalString = readStringValue;

export function normalizeStrictOpenAIJsonSchema(schema: unknown): unknown {
  return normalizeStrictOpenAIJsonSchemaRecursive(normalizeToolParameterSchema(schema ?? {}));
}

function normalizeStrictOpenAIJsonSchemaRecursive(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    let changed = false;
    const normalized = schema.map((entry) => {
      const next = normalizeStrictOpenAIJsonSchemaRecursive(entry);
      changed ||= next !== entry;
      return next;
    });
    return changed ? normalized : schema;
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const record = schema as Record<string, unknown>;
  let changed = false;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const next = normalizeStrictOpenAIJsonSchemaRecursive(value);
    normalized[key] = next;
    changed ||= next !== value;
  }

  if (normalized.type === "object") {
    const properties =
      normalized.properties &&
      typeof normalized.properties === "object" &&
      !Array.isArray(normalized.properties)
        ? (normalized.properties as Record<string, unknown>)
        : undefined;
    if (properties && Object.keys(properties).length === 0 && !Array.isArray(normalized.required)) {
      normalized.required = [];
      changed = true;
    }
  }

  return changed ? normalized : schema;
}

export function normalizeOpenAIStrictToolParameters<T>(schema: T, strict: boolean): T {
  if (!strict) {
    return normalizeToolParameterSchema(schema ?? {}) as T;
  }
  return normalizeStrictOpenAIJsonSchema(schema) as T;
}

export function isStrictOpenAIJsonSchemaCompatible(schema: unknown): boolean {
  return isStrictOpenAIJsonSchemaCompatibleRecursive(normalizeStrictOpenAIJsonSchema(schema));
}

function isStrictOpenAIJsonSchemaCompatibleRecursive(schema: unknown): boolean {
  if (Array.isArray(schema)) {
    return schema.every((entry) => isStrictOpenAIJsonSchemaCompatibleRecursive(entry));
  }
  if (!schema || typeof schema !== "object") {
    return true;
  }

  const record = schema as Record<string, unknown>;
  if ("anyOf" in record || "oneOf" in record || "allOf" in record) {
    return false;
  }
  if (Array.isArray(record.type)) {
    return false;
  }
  if (record.type === "object" && record.additionalProperties !== false) {
    return false;
  }
  if (record.type === "object") {
    const properties =
      record.properties &&
      typeof record.properties === "object" &&
      !Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(record.required)
      ? record.required.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    if (!required) {
      return false;
    }
    const requiredSet = new Set(required);
    if (Object.keys(properties).some((key) => !requiredSet.has(key))) {
      return false;
    }
  }

  return Object.entries(record).every(([key, entry]) => {
    if (key === "properties" && entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.values(entry as Record<string, unknown>).every((value) =>
        isStrictOpenAIJsonSchemaCompatibleRecursive(value),
      );
    }
    return isStrictOpenAIJsonSchemaCompatibleRecursive(entry);
  });
}

export function resolveOpenAIStrictToolFlagForInventory(
  tools: readonly ToolWithParameters[],
  strict: boolean | null | undefined,
): boolean | undefined {
  if (strict !== true) {
    return strict === false ? false : undefined;
  }
  return tools.every((tool) => isStrictOpenAIJsonSchemaCompatible(tool.parameters));
}

export function resolvesToNativeOpenAIStrictTools(
  model: OpenAIStrictToolModel,
  transport: OpenAITransportKind,
): boolean {
  const capabilities = resolveProviderRequestCapabilities({
    provider: optionalString(model.provider),
    api: optionalString(model.api),
    baseUrl: optionalString(model.baseUrl),
    capability: "llm",
    transport,
    modelId: optionalString(model.id),
    compat:
      model.compat && typeof model.compat === "object"
        ? (model.compat as { supportsStore?: boolean })
        : undefined,
  });
  if (!capabilities.usesKnownNativeOpenAIRoute) {
    return false;
  }
  return (
    capabilities.provider === "openai" ||
    capabilities.provider === "openai-codex" ||
    capabilities.provider === "azure-openai" ||
    capabilities.provider === "azure-openai-responses"
  );
}

export function resolveOpenAIStrictToolSetting(
  model: OpenAIStrictToolModel,
  options?: { transport?: OpenAITransportKind; supportsStrictMode?: boolean },
): boolean | undefined {
  if (resolvesToNativeOpenAIStrictTools(model, options?.transport ?? "stream")) {
    return true;
  }
  if (options?.supportsStrictMode) {
    return false;
  }
  return undefined;
}
