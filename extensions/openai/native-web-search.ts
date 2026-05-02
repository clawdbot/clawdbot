import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";
import { isOpenAIApiBaseUrl } from "./base-url.js";

const OPENAI_WEB_SEARCH_TOOL = { type: "web_search" } as const;

type OpenAINativeWebSearchPatchResult =
  | "payload_not_object"
  | "native_tool_already_present"
  | "injected";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

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
  return isRecord(tool) && tool.type === "function" && tool.name === OPENAI_WEB_SEARCH_TOOL.type;
}

function raiseMinimalReasoningForOpenAINativeWebSearch(payload: Record<string, unknown>): void {
  const reasoning = payload.reasoning;
  if (!isRecord(reasoning) || reasoning.effort !== "minimal") {
    return;
  }
  reasoning.effort = "low";
}

export function patchOpenAINativeWebSearchPayload(
  payload: unknown,
): OpenAINativeWebSearchPatchResult {
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

export function createOpenAINativeWebSearchWrapper(
  baseStreamFn: StreamFn | undefined,
  params: { config?: OpenClawConfig },
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!shouldEnableOpenAINativeWebSearch({ config: params.config, model })) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payload) => {
      patchOpenAINativeWebSearchPayload(payload);
    });
  };
}
