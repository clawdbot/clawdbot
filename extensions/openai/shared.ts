import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { findCatalogTemplate } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  cloneFirstTemplateModel,
  matchesExactOrPrefix,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { OPENAI_RESPONSES_STREAM_HOOKS } from "openclaw/plugin-sdk/provider-stream-family";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createOpenAINativeWebSearchWrapper } from "./native-web-search.js";
import { buildOpenAIReplayPolicy } from "./replay-policy.js";
import {
  resolveOpenAITransportTurnState,
  resolveOpenAIWebSocketSessionPolicy,
} from "./transport-policy.js";

type SyntheticOpenAIModelCatalogCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

type SyntheticOpenAIModelCatalogEntry = {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  contextTokens?: number;
  cost?: SyntheticOpenAIModelCatalogCost;
};

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

export function toOpenAIDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

export function resolveConfiguredOpenAIBaseUrl(cfg: OpenClawConfig | undefined): string {
  return normalizeOptionalString(cfg?.models?.providers?.openai?.baseUrl) ?? OPENAI_API_BASE_URL;
}

function hasSupportedOpenAIResponsesTransport(
  transport: unknown,
): transport is "auto" | "sse" | "websocket" {
  return transport === "auto" || transport === "sse" || transport === "websocket";
}

function defaultOpenAIResponsesExtraParams(
  extraParams: Record<string, unknown> | undefined,
  options?: { transport?: "auto" | "sse" | "websocket" },
): Record<string, unknown> | undefined {
  const hasSupportedTransport = hasSupportedOpenAIResponsesTransport(extraParams?.transport);
  const defaultTransport = options?.transport ?? "auto";
  if (hasSupportedTransport) {
    return extraParams;
  }

  return {
    ...extraParams,
    transport: defaultTransport,
  };
}

type OpenAIResponsesProviderHooks = Pick<
  ProviderPlugin,
  | "buildReplayPolicy"
  | "prepareExtraParams"
  | "wrapStreamFn"
  | "resolveTransportTurnState"
  | "resolveWebSocketSessionPolicy"
>;

const resolveOpenAIResponsesTransportTurnState: NonNullable<
  OpenAIResponsesProviderHooks["resolveTransportTurnState"]
> = (ctx) => resolveOpenAITransportTurnState(ctx);

const resolveOpenAIResponsesWebSocketSessionPolicy: NonNullable<
  OpenAIResponsesProviderHooks["resolveWebSocketSessionPolicy"]
> = (ctx) => resolveOpenAIWebSocketSessionPolicy(ctx);

const wrapOpenAIResponsesStreamFn = OPENAI_RESPONSES_STREAM_HOOKS.wrapStreamFn;
const wrapOpenAIResponsesProviderStreamFn: NonNullable<
  OpenAIResponsesProviderHooks["wrapStreamFn"]
> = (ctx) =>
  createOpenAINativeWebSearchWrapper(wrapOpenAIResponsesStreamFn?.(ctx) ?? ctx.streamFn, {
    config: ctx.config,
  });

export function buildOpenAIResponsesProviderHooks(options?: {
  transport?: "auto" | "sse" | "websocket";
}): OpenAIResponsesProviderHooks {
  return {
    buildReplayPolicy: buildOpenAIReplayPolicy,
    prepareExtraParams: (ctx) => defaultOpenAIResponsesExtraParams(ctx.extraParams, options),
    ...OPENAI_RESPONSES_STREAM_HOOKS,
    wrapStreamFn: wrapOpenAIResponsesProviderStreamFn,
    resolveTransportTurnState: resolveOpenAIResponsesTransportTurnState,
    resolveWebSocketSessionPolicy: resolveOpenAIResponsesWebSocketSessionPolicy,
  };
}

export function buildOpenAISyntheticCatalogEntry(
  template: ReturnType<typeof findCatalogTemplate>,
  entry: {
    id: string;
    reasoning: boolean;
    input: readonly ("text" | "image")[];
    contextWindow: number;
    contextTokens?: number;
    cost?: SyntheticOpenAIModelCatalogCost;
  },
): SyntheticOpenAIModelCatalogEntry | undefined {
  if (!template) {
    return undefined;
  }
  return {
    ...template,
    id: entry.id,
    name: entry.id,
    reasoning: entry.reasoning,
    input: [...entry.input],
    contextWindow: entry.contextWindow,
    ...(entry.contextTokens === undefined ? {} : { contextTokens: entry.contextTokens }),
    ...(entry.cost === undefined ? {} : { cost: entry.cost }),
  };
}

export { cloneFirstTemplateModel, findCatalogTemplate, matchesExactOrPrefix };
