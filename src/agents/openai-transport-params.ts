import {
  findOpenAIStrictToolProjectionDiagnostics,
  resolveOpenAIProjectedToolsStrictToolFlag,
  type OpenAIToolProjection,
} from "@openclaw/ai/internal/openai";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sha256Hex } from "../infra/crypto-digest.js";
import type { Context, Model } from "../llm/types.js";
import { isCodeModeModelVisibleToolName } from "./code-mode-control-tools.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./copilot-dynamic-headers.js";
import { detectOpenAICompletionsCompat } from "./openai-completions-compat.js";
import { resolveOpenAIReasoningEffortMap } from "./openai-reasoning-compat.js";
import { log, type OpenAIModeModel } from "./openai-transport-shared.js";
import { resolveProviderRequestPolicyConfig } from "./provider-request-config.js";
import { resolveModelRequestTimeoutMs } from "./provider-transport-fetch.js";

const MAX_OPENAI_STRICT_TOOL_DOWNGRADE_DIAGNOSTIC_KEYS = 256;
const OPENAI_CODEX_RESPONSES_PROVIDERS = new Set(["openai"]);
const loggedOpenAIStrictToolDowngradeDiagnosticKeys = new Set<string>();

function readToolPayloadField(record: Record<string, unknown>, field: string): unknown {
  try {
    return record[field];
  } catch {
    return undefined;
  }
}

function transportPayloadToolName(tool: unknown): string | undefined {
  if (!isRecord(tool)) {
    return undefined;
  }
  const name = readToolPayloadField(tool, "name");
  if (typeof name === "string") {
    return name;
  }
  const fn = readToolPayloadField(tool, "function");
  if (!isRecord(fn)) {
    return undefined;
  }
  const fnName = readToolPayloadField(fn, "name");
  return typeof fnName === "string" ? fnName : undefined;
}

export function enforceCodeModeResponsesToolSurface(payload: unknown): void {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) {
    return;
  }
  payload.tools = payload.tools.filter((tool) => {
    const name = transportPayloadToolName(tool);
    return typeof name === "string" && isCodeModeModelVisibleToolName(name);
  });
}

export function assertCodeModeResponsesToolSurface(payload: unknown): void {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) {
    throw new Error("Code mode payload tool surface violation: expected exec,wait; got no tools");
  }
  const names = payload.tools
    .map(transportPayloadToolName)
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .toSorted((left, right) => left.localeCompare(right));
  if (
    names.length >= 2 &&
    new Set(names).size === names.length &&
    names.filter((name) => name === "exec").length === 1 &&
    names.filter((name) => name === "wait").length === 1 &&
    names.every(isCodeModeModelVisibleToolName)
  ) {
    return;
  }
  throw new Error(
    `Code mode payload tool surface violation: expected exec,wait plus direct-only tools; got ${
      names.length > 0 ? names.join(",") : "none"
    }`,
  );
}

function buildOpenAIStrictToolDowngradeDiagnosticKey(
  diagnostics: ReturnType<typeof findOpenAIStrictToolProjectionDiagnostics>,
  context: { transport: "responses" | "completions"; model: OpenAIModeModel },
): string {
  return sha256Hex(
    JSON.stringify({
      transport: context.transport,
      provider: context.model.provider ?? null,
      model: context.model.id ?? null,
      diagnostics: diagnostics.map((entry) => ({
        toolIndex: entry.toolIndex,
        toolName: entry.toolName ?? null,
        violations: entry.violations,
      })),
    }),
  );
}

function shouldLogOpenAIStrictToolDowngradeDiagnostic(
  diagnostics: ReturnType<typeof findOpenAIStrictToolProjectionDiagnostics>,
  context: { transport: "responses" | "completions"; model: OpenAIModeModel },
): boolean {
  const key = buildOpenAIStrictToolDowngradeDiagnosticKey(diagnostics, context);
  if (loggedOpenAIStrictToolDowngradeDiagnosticKeys.has(key)) {
    return false;
  }
  if (
    loggedOpenAIStrictToolDowngradeDiagnosticKeys.size >=
    MAX_OPENAI_STRICT_TOOL_DOWNGRADE_DIAGNOSTIC_KEYS
  ) {
    loggedOpenAIStrictToolDowngradeDiagnosticKeys.clear();
  }
  loggedOpenAIStrictToolDowngradeDiagnosticKeys.add(key);
  return true;
}

export function resolveOpenAIStrictToolFlagWithDiagnostics(
  projection: OpenAIToolProjection,
  strictSetting: boolean | null | undefined,
  context: { transport: "responses" | "completions"; model: OpenAIModeModel },
): boolean | undefined {
  const strict = resolveOpenAIProjectedToolsStrictToolFlag(projection, strictSetting);
  if (strictSetting === true && strict === false && log.isEnabled("debug", "any")) {
    const diagnostics = findOpenAIStrictToolProjectionDiagnostics(projection);
    if (!shouldLogOpenAIStrictToolDowngradeDiagnostic(diagnostics, context)) {
      return strict;
    }
    const sample = diagnostics.slice(0, 5).map((entry) => ({
      tool: entry.toolName ?? `tool[${entry.toolIndex}]`,
      violations: entry.violations.slice(0, 8),
    }));
    log.debug(
      `OpenAI ${context.transport} tool schema strict mode downgraded to strict=false for ` +
        `${context.model.provider ?? "unknown"}/${context.model.id ?? "unknown"} ` +
        `because ${diagnostics.length} tool schema(s) are not strict-compatible`,
      {
        transport: context.transport,
        provider: context.model.provider,
        model: context.model.id,
        incompatibleToolCount: diagnostics.length,
        sample,
      },
    );
  }
  return strict;
}

export function isOpenAICodexResponsesModel(model: Model): boolean {
  return (
    OPENAI_CODEX_RESPONSES_PROVIDERS.has(model.provider) &&
    (model.api === "openai-chatgpt-responses" ||
      model.api === "openclaw-openai-responses-transport")
  );
}

function isNativeOpenAICodexResponsesBaseUrl(baseUrl?: string): boolean {
  const trimmed = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!trimmed) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    if (url.hostname.toLowerCase() !== "chatgpt.com") {
      return false;
    }
    const pathname = url.pathname.replace(/\/+$/u, "").toLowerCase();
    return [
      "/backend-api",
      "/backend-api/v1",
      "/backend-api/codex",
      "/backend-api/codex/v1",
    ].includes(pathname);
  } catch {
    return false;
  }
}

export function usesNativeOpenAICodexResponsesBackend(model: Model): boolean {
  return isOpenAICodexResponsesModel(model) && isNativeOpenAICodexResponsesBaseUrl(model.baseUrl);
}

export function buildOpenAIClientHeaders(
  model: Model,
  context: Context,
  optionHeaders?: Record<string, string>,
  turnHeaders?: Record<string, string>,
  sessionId?: string,
): Record<string, string> {
  const providerHeaders = { ...model.headers };
  if (model.provider === "github-copilot") {
    Object.assign(
      providerHeaders,
      buildCopilotDynamicHeaders({
        messages: context.messages,
        hasImages: hasCopilotVisionInput(context.messages),
      }),
    );
  }
  const callerHeaders = { ...optionHeaders, ...turnHeaders };
  const headers = resolveProviderRequestPolicyConfig({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    capability: "llm",
    transport: "stream",
    providerHeaders,
    callerHeaders: Object.keys(callerHeaders).length > 0 ? callerHeaders : undefined,
    precedence: "caller-wins",
  }).headers;
  const resolvedHeaders = headers ?? {};
  // Preserve ChatGPT Responses session affinity; the native backend accepts this spelling.
  if (
    sessionId &&
    !Object.keys(resolvedHeaders).some(
      (key) => normalizeLowercaseStringOrEmpty(key) === "session_id",
    ) &&
    usesNativeOpenAICodexResponsesBackend(model)
  ) {
    resolvedHeaders.session_id = sessionId;
  }
  return resolvedHeaders;
}

function resolveOpenAISdkTimeoutMs(model: Model): number | undefined {
  return resolveModelRequestTimeoutMs(model, undefined);
}

export function buildOpenAISdkClientOptions(model: Model): { timeout?: number } {
  const timeout = resolveOpenAISdkTimeoutMs(model);
  return timeout === undefined ? {} : { timeout };
}

export function buildOpenAISdkRequestOptions(
  model: Model,
  signal?: AbortSignal,
  options?: { stream?: boolean },
): { signal?: AbortSignal; timeout?: number; headers?: Record<string, string> } | undefined {
  const timeout = resolveOpenAISdkTimeoutMs(model);
  const headers =
    options?.stream === true && usesNativeOpenAICodexResponsesBackend(model)
      ? { Accept: "text/event-stream" }
      : undefined;
  if (timeout === undefined && !signal && !headers) {
    return undefined;
  }
  return {
    ...(headers ? { headers } : {}),
    ...(signal ? { signal } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

function detectCompat(model: OpenAIModeModel) {
  const { defaults } = detectOpenAICompletionsCompat(model);
  return {
    supportsStore: defaults.supportsStore,
    supportsDeveloperRole: defaults.supportsDeveloperRole,
    supportsReasoningEffort: defaults.supportsReasoningEffort,
    reasoningEffortMap: {},
    supportsUsageInStreaming: defaults.supportsUsageInStreaming,
    maxTokensField: defaults.maxTokensField,
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    thinkingFormat: defaults.thinkingFormat,
    visibleReasoningDetailTypes: defaults.visibleReasoningDetailTypes,
    openRouterRouting: {},
    vercelGatewayRouting: {},
    supportsStrictMode: defaults.supportsStrictMode,
    requiresReasoningContentOnAssistantMessages:
      defaults.requiresReasoningContentOnAssistantMessages,
    requiresNonEmptyUserOrAssistantMessage: defaults.requiresNonEmptyUserOrAssistantMessage,
  };
}

export function getCompat(model: OpenAIModeModel) {
  const detected = detectCompat(model);
  const compat = model.compat ?? {};
  const supportsStore =
    typeof compat.supportsStore === "boolean" ? compat.supportsStore : detected.supportsStore;
  const supportsReasoningEffort =
    typeof compat.supportsReasoningEffort === "boolean"
      ? compat.supportsReasoningEffort
      : detected.supportsReasoningEffort;
  return {
    supportsStore,
    supportsDeveloperRole: compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    supportsReasoningEffort,
    reasoningEffortMap: resolveOpenAIReasoningEffortMap(model, detected.reasoningEffortMap),
    supportsUsageInStreaming: compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
    maxTokensField: (compat.maxTokensField as string | undefined) ?? detected.maxTokensField,
    requiresToolResultName: compat.requiresToolResultName ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText: compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
    thinkingFormat: compat.thinkingFormat ?? detected.thinkingFormat,
    openRouterRouting: (compat.openRouterRouting as Record<string, unknown> | undefined) ?? {},
    vercelGatewayRouting:
      (compat.vercelGatewayRouting as Record<string, unknown> | undefined) ??
      detected.vercelGatewayRouting,
    supportsStrictMode: compat.supportsStrictMode ?? detected.supportsStrictMode,
    supportsPromptCacheKey: compat.supportsPromptCacheKey === true,
    supportsLongCacheRetention: compat.supportsLongCacheRetention !== false,
    requiresStringContent: compat.requiresStringContent ?? false,
    strictMessageKeys: compat.strictMessageKeys === true,
    visibleReasoningDetailTypes:
      compat.visibleReasoningDetailTypes ?? detected.visibleReasoningDetailTypes,
    requiresReasoningContentOnAssistantMessages:
      compat.requiresReasoningContentOnAssistantMessages ??
      detected.requiresReasoningContentOnAssistantMessages,
    requiresNonEmptyUserOrAssistantMessage: detected.requiresNonEmptyUserOrAssistantMessage,
  };
}
