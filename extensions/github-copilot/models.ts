import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/core";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeModelCompat } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCopilotTransportApi, resolveStaticCopilotModelOverride } from "./model-metadata.js";

export const PROVIDER_ID = "github-copilot";
const CODEX_FORWARD_COMPAT_TARGET_IDS = new Set(["gpt-5.4", "gpt-5.3-codex"]);
// gpt-5.3-codex is only a useful template when gpt-5.4 is the target; it is
// always a registry miss (and therefore skipped) when it is the target itself.
const CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.3-codex", "gpt-5.2-codex"] as const;

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

function isCopilotCodexModelId(modelId: string): boolean {
  return /(?:^|[-_.])codex(?:$|[-_.])/.test(modelId);
}

export function resolveCopilotForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmedModelId = ctx.modelId.trim();
  if (!trimmedModelId) {
    return undefined;
  }

  // If the model is already in the registry, let the normal path handle it.
  const lowerModelId = normalizeOptionalLowercaseString(trimmedModelId) ?? "";
  const existing = ctx.modelRegistry.find(PROVIDER_ID, lowerModelId);
  if (existing) {
    return undefined;
  }

  // For gpt-5.4 and gpt-5.3-codex, clone from a registered codex template
  // to inherit the correct reasoning and capability flags.
  if (CODEX_FORWARD_COMPAT_TARGET_IDS.has(lowerModelId)) {
    for (const templateId of CODEX_TEMPLATE_MODEL_IDS) {
      const template = ctx.modelRegistry.find(
        PROVIDER_ID,
        templateId,
      ) as ProviderRuntimeModel | null;
      if (!template) {
        continue;
      }
      return normalizeModelCompat({
        ...template,
        id: trimmedModelId,
        name: trimmedModelId,
      } as ProviderRuntimeModel);
    }
    // Template not found — fall through to synthetic catch-all below.
  }

  const staticOverride = resolveStaticCopilotModelOverride(lowerModelId);
  if (staticOverride) {
    return normalizeModelCompat({
      id: trimmedModelId,
      name: staticOverride.name ?? trimmedModelId,
      provider: PROVIDER_ID,
      api: staticOverride.api ?? resolveCopilotTransportApi(trimmedModelId),
      reasoning: staticOverride.reasoning ?? false,
      input: staticOverride.input ?? ["text", "image"],
      cost: staticOverride.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: staticOverride.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: staticOverride.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(staticOverride.compat ? { compat: staticOverride.compat } : {}),
    } as ProviderRuntimeModel);
  }

  // Catch-all: create a synthetic model definition for any unknown model ID.
  // The Copilot API is OpenAI-compatible and will return its own error if the
  // model isn't available on the user's plan. This lets new models be used
  // by simply adding them to agents.defaults.models in openclaw.json — no
  // code change required.
  const reasoning = /^o[13](\b|$)/.test(lowerModelId) || isCopilotCodexModelId(lowerModelId);
  return normalizeModelCompat({
    id: trimmedModelId,
    name: trimmedModelId,
    provider: PROVIDER_ID,
    api: resolveCopilotTransportApi(trimmedModelId),
    reasoning,
    // Optimistic: most Copilot models support images, and the API rejects
    // image payloads for text-only models rather than failing silently.
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  } as ProviderRuntimeModel);
}

// Subset of the Copilot /models response shape that we depend on. We only read
// fields we need; everything else is preserved as `unknown` so upstream changes
// don't break parsing.
type CopilotApiModelEntry = {
  id?: string;
  name?: string;
  object?: string;
  vendor?: string;
  preview?: boolean;
  model_picker_enabled?: boolean;
  capabilities?: {
    type?: string;
    family?: string;
    limits?: {
      max_context_window_tokens?: number;
      max_output_tokens?: number;
      max_prompt_tokens?: number;
    };
    supports?: {
      vision?: boolean;
      tool_calls?: boolean;
      streaming?: boolean;
      structured_outputs?: boolean;
      reasoning_effort?: string[] | null;
    };
  };
};

const COPILOT_MODELS_LIST_DEFAULT_TIMEOUT_MS = 10_000;
const COPILOT_ROUTER_ID_PREFIX = "accounts/";

function resolveCopilotApiForVendor(
  vendor: string | undefined,
  modelId: string,
): "anthropic-messages" | "openai-responses" {
  if (vendor && vendor.toLowerCase() === "anthropic") {
    return "anthropic-messages";
  }
  return resolveCopilotTransportApi(modelId);
}

function mapCopilotApiModelToDefinition(
  entry: CopilotApiModelEntry,
): ModelDefinitionConfig | undefined {
  const id = entry.id?.trim();
  if (!id) {
    return undefined;
  }
  // Skip non-chat objects (embeddings, routers, etc.) and internal router ids.
  if (entry.object && entry.object !== "model") {
    return undefined;
  }
  if (entry.capabilities?.type && entry.capabilities.type !== "chat") {
    return undefined;
  }
  if (id.startsWith(COPILOT_ROUTER_ID_PREFIX)) {
    return undefined;
  }

  const limits = entry.capabilities?.limits;
  const supports = entry.capabilities?.supports;
  const reasoning = Array.isArray(supports?.reasoning_effort)
    ? supports.reasoning_effort.length > 0
    : false;
  const supportsVision = supports?.vision === true;
  const input: ModelDefinitionConfig["input"] = supportsVision ? ["text", "image"] : ["text"];

  const contextWindow =
    typeof limits?.max_context_window_tokens === "number" && limits.max_context_window_tokens > 0
      ? limits.max_context_window_tokens
      : DEFAULT_CONTEXT_WINDOW;
  const maxTokens =
    typeof limits?.max_output_tokens === "number" && limits.max_output_tokens > 0
      ? limits.max_output_tokens
      : DEFAULT_MAX_TOKENS;

  const definition: ModelDefinitionConfig = {
    id,
    name: entry.name?.trim() || id,
    api: resolveCopilotApiForVendor(entry.vendor, id),
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
  return definition;
}

export type FetchCopilotModelCatalogParams = {
  /** Short-lived Copilot API token (from `resolveCopilotApiToken`). */
  copilotApiToken: string;
  /** Resolved baseUrl from the same token-exchange response. */
  baseUrl: string;
  /** Optional fetch override for testing. */
  fetchImpl?: typeof fetch;
  /** Optional AbortSignal; defaults to a 10s timeout. */
  signal?: AbortSignal;
};

/**
 * Fetch the live Copilot model catalog from `${baseUrl}/models` and project it
 * into `ModelDefinitionConfig[]`. Used by the plugin's discovery hook so the
 * runtime catalog tracks per-account entitlements + accurate context windows
 * without manifest churn.
 *
 * Filters out non-chat objects (embeddings, routers) and internal router ids.
 * On any HTTP/parse failure the caller should fall back to the static manifest
 * catalog; this function throws so the caller decides the recovery shape.
 */
export async function fetchCopilotModelCatalog(
  params: FetchCopilotModelCatalogParams,
): Promise<ModelDefinitionConfig[]> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const trimmedBase = params.baseUrl.replace(/\/+$/, "");
  if (!trimmedBase) {
    throw new Error("fetchCopilotModelCatalog: baseUrl required");
  }
  if (!params.copilotApiToken.trim()) {
    throw new Error("fetchCopilotModelCatalog: copilotApiToken required");
  }
  const url = `${trimmedBase}/models`;
  const controller = params.signal ? undefined : new AbortController();
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), COPILOT_MODELS_LIST_DEFAULT_TIMEOUT_MS)
    : undefined;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.copilotApiToken}`,
        "Editor-Version": "vscode/1.96.2",
        "Copilot-Integration-Id": "vscode-chat",
      },
      signal: params.signal ?? controller?.signal,
    });
    if (!res.ok) {
      throw new Error(`Copilot /models fetch failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { data?: CopilotApiModelEntry[] };
    const data = Array.isArray(json?.data) ? json.data : [];
    const seen = new Set<string>();
    const out: ModelDefinitionConfig[] = [];
    for (const entry of data) {
      const def = mapCopilotApiModelToDefinition(entry);
      if (!def) {
        continue;
      }
      if (seen.has(def.id)) {
        continue;
      }
      seen.add(def.id);
      out.push(def);
    }
    return out;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
