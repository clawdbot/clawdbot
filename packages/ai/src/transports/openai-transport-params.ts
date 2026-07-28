import type { Context, Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getAiTransportHost } from "../host.js";
import { clampOpenAIPromptCacheKey } from "../providers/openai-prompt-cache.js";
import type { OpenAIToolProjection } from "../providers/openai-tool-projection.js";
import {
  findOpenAIStrictToolProjectionDiagnostics,
  resolveOpenAIProjectedToolsStrictToolFlag,
} from "../providers/openai-tool-schema.js";
import { resolveModelRequestTimeoutMs, resolveProviderRequestPolicyConfig } from "./host-policy.js";
import { resolveOpenAICompletionsCompat } from "./openai-completions-compat.js";
import { resolveOpenAIReasoningEffortMap } from "./openai-reasoning-compat.js";
import type { OpenAIModeModel } from "./openai-transport-shared.js";
import { isCodeModeModelVisibleToolName, sha256Hex } from "./transport-utils.js";

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
  if (strictSetting === true && strict === false) {
    const diagnostics = findOpenAIStrictToolProjectionDiagnostics(projection);
    getAiTransportHost().logDebug("openai-transport", () => {
      if (!shouldLogOpenAIStrictToolDowngradeDiagnostic(diagnostics, context)) {
        return null;
      }
      const sample = diagnostics.slice(0, 5).map((entry) => ({
        tool: entry.toolName ?? `tool[${entry.toolIndex}]`,
        violations: entry.violations.slice(0, 8),
      }));
      return {
        message:
          `OpenAI ${context.transport} tool schema strict mode downgraded to strict=false for ` +
          `${context.model.provider ?? "unknown"}/${context.model.id ?? "unknown"} ` +
          `because ${diagnostics.length} tool schema(s) are not strict-compatible`,
        data: {
          transport: context.transport,
          provider: context.model.provider,
          model: context.model.id,
          incompatibleToolCount: diagnostics.length,
          sample,
        },
      };
    });
  }
  return strict;
}

export function isOpenAICodexResponsesModel(model: Model): boolean {
  return (
    OPENAI_CODEX_RESPONSES_PROVIDERS.has(model.provider) &&
    (model.api === "openai-chatgpt-responses" ||
      model.api === "openclaw-openai-chatgpt-responses-transport")
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
      getAiTransportHost().buildCopilotDynamicHeaders(context.messages),
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
    // The backend derives its prompt cache key from this header and enforces
    // OpenAI's 64-char limit server-side; long internal session ids
    // (companion/btw effects sessions) 400 without this clamp.
    resolvedHeaders.session_id = clampOpenAIPromptCacheKey(sessionId) ?? sessionId;
  }
  return resolvedHeaders;
}

function resolveOpenAISdkTimeoutMs(model: Model, timeoutMs?: number): number | undefined {
  return resolveModelRequestTimeoutMs(model, timeoutMs);
}

export function buildOpenAISdkClientOptions(model: Model): { timeout?: number } {
  const timeout = resolveOpenAISdkTimeoutMs(model);
  return timeout === undefined ? {} : { timeout };
}

export function buildOpenAISdkRequestOptions(
  model: Model,
  signal?: AbortSignal,
  options?: { stream?: boolean; timeoutMs?: number; maxRetries?: number },
):
  | {
      signal?: AbortSignal;
      timeout?: number;
      maxRetries?: number;
      headers?: Record<string, string>;
    }
  | undefined {
  const timeout = resolveOpenAISdkTimeoutMs(model, options?.timeoutMs);
  const headers =
    options?.stream === true && usesNativeOpenAICodexResponsesBackend(model)
      ? { Accept: "text/event-stream" }
      : undefined;
  if (timeout === undefined && options?.maxRetries === undefined && !signal && !headers) {
    return undefined;
  }
  return {
    ...(headers ? { headers } : {}),
    ...(signal ? { signal } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
  };
}

export function getCompat(model: OpenAIModeModel) {
  const resolved = resolveOpenAICompletionsCompat(model as Model<"openai-completions">);
  const compat = model.compat ?? {};
  return {
    ...resolved,
    cacheControlFormat: resolved.cacheControlFormat,
    reasoningEffortMap: resolveOpenAIReasoningEffortMap(model, {}),
    openRouterRouting: (resolved.openRouterRouting as Record<string, unknown> | undefined) ?? {},
    vercelGatewayRouting: resolved.vercelGatewayRouting as Record<string, unknown>,
    requiresStringContent: compat.requiresStringContent ?? false,
    strictMessageKeys: compat.strictMessageKeys === true,
  };
}
