import type { Context, Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getAiTransportHost } from "../host.js";
import type { CodeModeToolSurfaceObservation } from "../provider-options.js";
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
import { resolveOpencodeSessionHeaders } from "./session-affinity.js";
import { isCodeModeModelVisibleToolName, sha256Hex } from "./transport-utils.js";

const MAX_OPENAI_STRICT_TOOL_DOWNGRADE_DIAGNOSTIC_KEYS = 256;
const OPENAI_CODEX_RESPONSES_PROVIDERS = new Set(["openai"]);
const loggedOpenAIStrictToolDowngradeDiagnosticKeys = new Set<string>();

function readToolPayloadField(record: Record<string, unknown>, field: string): unknown {
  try {
    return Object.hasOwn(record, field) ? record[field] : undefined;
  } catch {
    return undefined;
  }
}

export function readCodeModePayloadToolName(tool: unknown): string | undefined {
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

function readCodeModePayloadToolIdentity(
  tool: unknown,
  visibleToolNames: ReadonlySet<string>,
  allowedHostedToolTypes?: ReadonlySet<string>,
): string | false | undefined {
  if (!isRecord(tool)) {
    return undefined;
  }
  const type = readToolPayloadField(tool, "type");
  if (typeof type === "string" && allowedHostedToolTypes?.has(type)) {
    try {
      if (
        Object.hasOwn(tool, "name") ||
        Object.hasOwn(tool, "function") ||
        Object.hasOwn(tool, "functionDeclarations") ||
        Object.hasOwn(tool, "function_declarations")
      ) {
        return false;
      }
    } catch {
      return false;
    }
    return `hosted:${type}`;
  }
  const name = readCodeModePayloadToolName(tool);
  return typeof name === "string" && isCodeModeModelVisibleToolName(name, visibleToolNames)
    ? `client:${name}`
    : undefined;
}

function readCodeModePayloadToolIdentities(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [];
  }
  const tools = readToolPayloadField(payload, "tools");
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.flatMap((tool) => {
    if (!isRecord(tool)) {
      return [];
    }
    const identities: string[] = [];
    const name = readCodeModePayloadToolName(tool);
    if (name) {
      identities.push(`client:${name}`);
    }
    for (const key of ["functionDeclarations", "function_declarations"] as const) {
      const declarations = readToolPayloadField(tool, key);
      if (!Array.isArray(declarations)) {
        continue;
      }
      for (const declaration of declarations) {
        const declarationName = readCodeModePayloadToolName(declaration);
        if (declarationName) {
          identities.push(`client:${declarationName}`);
        }
      }
    }
    const type = readToolPayloadField(tool, "type");
    if (typeof type === "string" && type !== "function") {
      identities.push(`hosted:${type}`);
    }
    return identities;
  });
}

export function filterCodeModePayloadTools(
  payload: unknown,
  visibleToolNames: ReadonlySet<string>,
  allowedHostedToolTypes?: ReadonlySet<string>,
  observer?: (observation: CodeModeToolSurfaceObservation) => void,
): void {
  if (!isRecord(payload)) {
    return;
  }
  const tools = readToolPayloadField(payload, "tools");
  if (!Array.isArray(tools)) {
    return;
  }
  const beforeToolIdentities = observer ? readCodeModePayloadToolIdentities(payload) : undefined;
  payload.tools = tools.flatMap((tool) => {
    const identity = readCodeModePayloadToolIdentity(
      tool,
      visibleToolNames,
      allowedHostedToolTypes,
    );
    if (identity) {
      return [tool];
    }
    if (identity === false) {
      return [];
    }
    if (!isRecord(tool)) {
      return [];
    }
    const filteredGroups: Record<string, unknown> = {};
    for (const key of ["functionDeclarations", "function_declarations"] as const) {
      const declarations = readToolPayloadField(tool, key);
      if (!Array.isArray(declarations)) {
        continue;
      }
      const filtered = declarations.filter((declaration) => {
        const declarationName = readCodeModePayloadToolName(declaration);
        return (
          typeof declarationName === "string" &&
          isCodeModeModelVisibleToolName(declarationName, visibleToolNames)
        );
      });
      if (filtered.length > 0) {
        filteredGroups[key] = filtered;
      }
    }
    return Object.keys(filteredGroups).length > 0 ? [filteredGroups] : [];
  });
  if (beforeToolIdentities) {
    observer?.({
      beforeToolIdentities,
      afterToolIdentities: readCodeModePayloadToolIdentities(payload),
    });
  }
}

export function resolveCodeModeResponsesVisibleToolNames(
  context: Pick<Context, "tools">,
): ReadonlySet<string> {
  return new Set(
    (context.tools ?? [])
      .map(readCodeModePayloadToolName)
      .filter((name): name is string => typeof name === "string"),
  );
}

export function enforceCodeModeResponsesToolSurface(
  payload: unknown,
  visibleToolNames: ReadonlySet<string>,
  allowedHostedToolTypes?: ReadonlySet<string>,
  observer?: (observation: CodeModeToolSurfaceObservation) => void,
): void {
  if (!isRecord(payload)) {
    return;
  }
  const tools = readToolPayloadField(payload, "tools");
  if (!Array.isArray(tools)) {
    return;
  }
  const beforeToolIdentities = observer ? readCodeModePayloadToolIdentities(payload) : undefined;
  payload.tools = tools.filter((tool) =>
    Boolean(readCodeModePayloadToolIdentity(tool, visibleToolNames, allowedHostedToolTypes)),
  );
  if (beforeToolIdentities) {
    observer?.({
      beforeToolIdentities,
      afterToolIdentities: readCodeModePayloadToolIdentities(payload),
    });
  }
}

export function assertCodeModeResponsesToolSurface(
  payload: unknown,
  visibleToolNames: ReadonlySet<string>,
  allowedHostedToolTypes?: ReadonlySet<string>,
): void {
  const tools = isRecord(payload) ? readToolPayloadField(payload, "tools") : undefined;
  if (!Array.isArray(tools)) {
    throw new Error("Code mode payload tool surface violation: expected exec,wait; got no tools");
  }
  const identities = tools.map((tool) =>
    readCodeModePayloadToolIdentity(tool, visibleToolNames, allowedHostedToolTypes),
  );
  const names = identities
    .flatMap((identity) =>
      typeof identity === "string" && identity.startsWith("client:")
        ? [identity.slice("client:".length)]
        : [],
    )
    .toSorted((left, right) => left.localeCompare(right));
  if (
    names.length >= 2 &&
    identities.every((identity): identity is string => typeof identity === "string") &&
    new Set(identities).size === identities.length &&
    names.includes("exec") &&
    names.includes("wait")
  ) {
    return;
  }
  throw new Error(
    `Code mode payload tool surface violation: expected exec,wait plus direct-only tools; got ${
      names.length > 0 ? names.join(",") : "none"
    }`,
  );
}

export function resolveOpenAIStrictToolFlagWithDiagnostics(
  projection: OpenAIToolProjection,
  strictSetting: boolean | null | undefined,
  context: { transport: "responses" | "completions"; model: OpenAIModeModel },
): boolean | undefined {
  const strict = resolveOpenAIProjectedToolsStrictToolFlag(projection, strictSetting);
  if (strictSetting === true && strict === false) {
    getAiTransportHost().logDebug("openai-transport", () => {
      const diagnostics = findOpenAIStrictToolProjectionDiagnostics(projection);
      const key = sha256Hex(
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
      if (loggedOpenAIStrictToolDowngradeDiagnosticKeys.has(key)) {
        return null;
      }
      if (
        loggedOpenAIStrictToolDowngradeDiagnosticKeys.size >=
        MAX_OPENAI_STRICT_TOOL_DOWNGRADE_DIAGNOSTIC_KEYS
      ) {
        loggedOpenAIStrictToolDowngradeDiagnosticKeys.clear();
      }
      loggedOpenAIStrictToolDowngradeDiagnosticKeys.add(key);
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
      "/backend-api/codex/responses",
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
  const headers = resolveProviderRequestPolicyConfig(model, {
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
  return (
    resolveOpencodeSessionHeaders(model, { sessionId, headers: resolvedHeaders }) ?? resolvedHeaders
  );
}

function resolveOpenAISdkTimeoutMs(model: Model, timeoutMs?: number): number | undefined {
  return resolveModelRequestTimeoutMs(model, timeoutMs);
}

export function buildOpenAISdkClientOptions(model: Model): { timeout?: number; maxRetries: 0 } {
  const timeout = resolveOpenAISdkTimeoutMs(model);
  return { ...(timeout === undefined ? {} : { timeout }), maxRetries: 0 };
}

export function buildOpenAISdkRequestOptions(
  model: Model,
  signal?: AbortSignal,
  options?: { stream?: boolean; timeoutMs?: number },
):
  | {
      signal?: AbortSignal;
      timeout?: number;
      // Always 0: the embedded runner's failover controller is the only retry
      // owner; SDK-internal retries would hide attempts from its budget.
      maxRetries: 0;
      headers?: Record<string, string>;
    }
  | undefined {
  const timeout = resolveOpenAISdkTimeoutMs(model, options?.timeoutMs);
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
    maxRetries: 0,
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
