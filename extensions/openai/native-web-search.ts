// Openai plugin module implements native web search behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  createPayloadPatchStreamWrapper,
  readProviderPromptAccountingContext,
  withProviderPromptAccountingContext,
  type ProviderPromptAccountingContext,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isOpenAIApiBaseUrl } from "./base-url.js";

const OPENAI_WEB_SEARCH_TOOL = { type: "web_search" } as const;

type OpenAINativeWebSearchPatchResult =
  | "payload_not_object"
  | "native_tool_already_present"
  | "injected";

function isOpenAINativeWebSearchEligibleModel(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): boolean {
  const provider = typeof model.provider === "string" ? model.provider : undefined;
  if (model.api !== "openai-responses" || !provider || normalizeProviderId(provider) !== "openai") {
    return false;
  }
  const baseUrl = typeof model.baseUrl === "string" ? model.baseUrl : undefined;
  return !baseUrl || isOpenAIApiBaseUrl(baseUrl);
}

function shouldUseOpenAINativeWebSearchProvider(config: OpenClawConfig | undefined): boolean {
  const provider = config?.tools?.web?.search?.provider;
  if (typeof provider !== "string") {
    return true;
  }
  const normalized = provider.trim().toLowerCase();
  return normalized === "" || normalized === "auto" || normalized === "openai";
}

function shouldEnableOpenAINativeWebSearch(params: {
  config?: OpenClawConfig;
  model: { api?: unknown; provider?: unknown; baseUrl?: unknown };
}): boolean {
  return (
    params.config?.tools?.web?.search?.enabled !== false &&
    shouldUseOpenAINativeWebSearchProvider(params.config) &&
    isOpenAINativeWebSearchEligibleModel(params.model)
  );
}

function isNativeWebSearchTool(tool: unknown): boolean {
  return isRecord(tool) && tool.type === OPENAI_WEB_SEARCH_TOOL.type;
}

function isManagedWebSearchTool(tool: unknown): boolean {
  return (
    isRecord(tool) &&
    tool.name === OPENAI_WEB_SEARCH_TOOL.type &&
    (tool.type === undefined || tool.type === "function")
  );
}

function raiseMinimalReasoningForOpenAINativeWebSearch(payload: Record<string, unknown>): void {
  const reasoning = payload.reasoning;
  if (!isRecord(reasoning) || reasoning.effort !== "minimal") {
    return;
  }
  reasoning.effort = "low";
}

function patchOpenAINativeWebSearchPayload(payload: unknown): OpenAINativeWebSearchPatchResult {
  if (!isRecord(payload)) {
    return "payload_not_object";
  }

  const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
  const filteredTools = existingTools.filter((tool) => !isManagedWebSearchTool(tool));
  if (filteredTools.some(isNativeWebSearchTool)) {
    if (filteredTools.length !== existingTools.length) {
      payload.tools = filteredTools;
    }
    raiseMinimalReasoningForOpenAINativeWebSearch(payload);
    return "native_tool_already_present";
  }

  payload.tools = [...filteredTools, OPENAI_WEB_SEARCH_TOOL];
  raiseMinimalReasoningForOpenAINativeWebSearch(payload);
  return "injected";
}

/** Mirrors the payload tool swap on the admission accounting surface. */
function projectOpenAINativeWebSearchAccountingTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  const filteredTools = tools.filter((tool) => !isManagedWebSearchTool(tool));
  if (filteredTools.some(isNativeWebSearchTool)) {
    return filteredTools;
  }
  return [...filteredTools, OPENAI_WEB_SEARCH_TOOL];
}

/** Carries the post-patch provider tool surface to admission before the payload is rebuilt. */
function withOpenAINativeWebSearchAccounting(
  options: Parameters<StreamFn>[2],
  context: Parameters<StreamFn>[1],
): Parameters<StreamFn>[2] {
  const incoming = readProviderPromptAccountingContext(options);
  const contextTools = (context as { tools?: unknown } | undefined)?.tools;
  const sourceTools = Array.isArray(incoming?.tools)
    ? incoming.tools
    : Array.isArray(contextTools)
      ? contextTools
      : undefined;
  const accountingTools = projectOpenAINativeWebSearchAccountingTools(sourceTools);
  if (!incoming && accountingTools === undefined) {
    return options;
  }
  const accountingContext: ProviderPromptAccountingContext = {
    systemPrompt:
      incoming?.systemPrompt ?? (context as { systemPrompt?: string } | undefined)?.systemPrompt,
    ...(accountingTools !== undefined ? { tools: accountingTools } : {}),
  };
  return withProviderPromptAccountingContext(options ?? {}, accountingContext);
}

export function createOpenAINativeWebSearchWrapper(
  baseStreamFn: StreamFn | undefined,
  params: {
    config?: OpenClawConfig;
    agentId?: string;
    nativeWebSearchAllowedByToolPolicy?: boolean;
  },
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  const patchingStream = createPayloadPatchStreamWrapper(underlying, ({ payload }) => {
    patchOpenAINativeWebSearchPayload(payload);
  });
  return (model, context, options) => {
    if (
      params.nativeWebSearchAllowedByToolPolicy === false ||
      !shouldEnableOpenAINativeWebSearch({ config: params.config, model })
    ) {
      return underlying(model, context, options);
    }
    return patchingStream(model, context, withOpenAINativeWebSearchAccounting(options, context));
  };
}
