import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "openclaw/plugin-sdk/provider-setup";
import { asBoolean, asPositiveSafeInteger } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LLAMA_SERVER_DEFAULT_ORIGIN } from "./defaults.js";
import { normalizeLlamaServerProviderConfig } from "./endpoint.js";

type LlamaServerModelStatus =
  | "unloaded"
  | "loading"
  | "loaded"
  | "sleeping"
  | "downloading"
  | "unknown";

type LlamaServerModelWire = Record<string, unknown> & {
  id?: unknown;
  object?: unknown;
  status?: {
    value?: unknown;
    failed?: unknown;
  };
  architecture?: {
    input_modalities?: unknown;
  };
};

type LlamaServerPropsWire = Record<string, unknown> & {
  n_ctx?: unknown;
  default_generation_settings?: {
    n_ctx?: unknown;
    params?: {
      max_tokens?: unknown;
      n_predict?: unknown;
    };
  };
  chat_template_caps?: Record<string, unknown>;
  modalities?: Record<string, unknown>;
};

export type LlamaServerDiscoveredModel = {
  config: ModelDefinitionConfig;
  status: LlamaServerModelStatus;
  failed: boolean;
};

function normalizeStatus(value: unknown): LlamaServerModelStatus {
  switch (value) {
    case "unloaded":
    case "loading":
    case "loaded":
    case "sleeping":
    case "downloading":
      return value;
    default:
      return "unknown";
  }
}

function resolveContextWindow(props: LlamaServerPropsWire | undefined): number {
  return (
    asPositiveSafeInteger(props?.default_generation_settings?.n_ctx) ??
    asPositiveSafeInteger(props?.n_ctx) ??
    SELF_HOSTED_DEFAULT_CONTEXT_WINDOW
  );
}

function resolveMaxTokens(props: LlamaServerPropsWire | undefined, contextWindow: number): number {
  const params = props?.default_generation_settings?.params;
  const advertised =
    asPositiveSafeInteger(params?.max_tokens) ?? asPositiveSafeInteger(params?.n_predict);
  return Math.min(advertised ?? SELF_HOSTED_DEFAULT_MAX_TOKENS, contextWindow);
}

function resolveInput(
  row: LlamaServerModelWire,
  props: LlamaServerPropsWire | undefined,
): Array<"text" | "image"> {
  const advertised = row.architecture?.input_modalities;
  const supportsImage =
    (Array.isArray(advertised) && advertised.includes("image")) ||
    props?.modalities?.vision === true;
  return supportsImage ? ["text", "image"] : ["text"];
}

function buildCompat(
  props: LlamaServerPropsWire | undefined,
): NonNullable<ModelDefinitionConfig["compat"]> {
  const caps = props?.chat_template_caps;
  const supportsTools = asBoolean(caps?.supports_tool_calls) === true;
  const supportsTypedContent = asBoolean(caps?.supports_typed_content) === true;
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsTemperature: true,
    supportsUsageInStreaming: true,
    supportsTools,
    supportsStrictMode: false,
    supportsJsonSchemaResponseFormat: true,
    requiresStringContent: !supportsTypedContent,
    maxTokensField: "max_tokens",
  };
}

/** Maps one llama-server model row plus optional runtime properties into OpenClaw config. */
export function mapLlamaServerModel(
  row: LlamaServerModelWire,
  props?: LlamaServerPropsWire,
): LlamaServerDiscoveredModel | null {
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id || (row.object !== undefined && row.object !== "model")) {
    return null;
  }
  const contextWindow = resolveContextWindow(props);
  return {
    config: {
      id,
      name: id,
      reasoning: false,
      input: resolveInput(row, props),
      cost: { ...SELF_HOSTED_DEFAULT_COST },
      contextWindow,
      contextTokens: contextWindow,
      maxTokens: resolveMaxTokens(props, contextWindow),
      compat: buildCompat(props),
    },
    status: normalizeStatus(row.status?.value),
    failed: row.status?.failed === true,
  };
}

/** Keeps explicit rows first and appends models discovered from the server. */
function mergeLlamaServerModels(params: {
  explicitModels?: ModelDefinitionConfig[];
  discoveredModels: readonly LlamaServerDiscoveredModel[];
}): ModelDefinitionConfig[] {
  const explicit = Array.isArray(params.explicitModels) ? params.explicitModels : [];
  const merged = [...explicit];
  const seen = new Set(explicit.map((model) => model.id));
  for (const discovered of params.discoveredModels) {
    if (seen.has(discovered.config.id)) {
      continue;
    }
    seen.add(discovered.config.id);
    merged.push(discovered.config);
  }
  return merged;
}

export function buildLlamaServerProviderConfig(params: {
  configured?: ModelProviderConfig;
  discoveredModels: readonly LlamaServerDiscoveredModel[];
}): ModelProviderConfig {
  return normalizeLlamaServerProviderConfig({
    ...params.configured,
    baseUrl: params.configured?.baseUrl ?? LLAMA_SERVER_DEFAULT_ORIGIN,
    models: mergeLlamaServerModels({
      explicitModels: params.configured?.models,
      discoveredModels: params.discoveredModels,
    }),
  });
}
