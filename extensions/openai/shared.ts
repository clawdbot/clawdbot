// Openai plugin module implements shared behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createLazyRuntimeModule,
  createLazyRuntimeSurface,
} from "openclaw/plugin-sdk/lazy-runtime";
import {
  buildFirstTemplateModel,
  findCatalogTemplate,
  matchesExactOrPrefix,
} from "openclaw/plugin-sdk/provider-model-metadata";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildOpenAIReplayPolicy } from "./replay-policy.js";
import { resolveOpenAITransportTurnState } from "./transport-policy.js";

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

export const OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS = 272_000;

export function resolveConfiguredOpenAIBaseUrl(cfg: OpenClawConfig | undefined): string {
  return normalizeOptionalString(cfg?.models?.providers?.openai?.baseUrl) ?? OPENAI_API_BASE_URL;
}

function hasSupportedOpenAIResponsesTransport(
  transport: unknown,
): transport is "auto" | "sse" | "websocket" | "websocket-cached" {
  return (
    transport === "auto" ||
    transport === "sse" ||
    transport === "websocket" ||
    transport === "websocket-cached"
  );
}

function defaultOpenAIResponsesExtraParams(
  extraParams: Record<string, unknown> | undefined,
  options?: { transport?: "auto" | "sse" | "websocket" | "websocket-cached" },
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
  "buildReplayPolicy" | "prepareExtraParams" | "wrapStreamFn" | "resolveTransportTurnState"
>;

const resolveOpenAIResponsesTransportTurnState: NonNullable<
  OpenAIResponsesProviderHooks["resolveTransportTurnState"]
> = (ctx) => resolveOpenAITransportTurnState(ctx);

const loadResponsesStream = createLazyRuntimeModule(() => import("./responses-stream.runtime.js"));
const wrapOpenAIResponsesProviderStreamFn: NonNullable<
  OpenAIResponsesProviderHooks["wrapStreamFn"]
> = (ctx) => {
  // Catalog registration keeps synchronous hooks; StreamFn already permits async
  // startup, so transport and tool execution load only when the stream is invoked.
  const loadStream = createLazyRuntimeSurface(loadResponsesStream, (runtime) =>
    runtime.wrapOpenAIResponsesStream(ctx),
  );
  return async (...args) => (await loadStream())(...args);
};

export function buildOpenAIResponsesProviderHooks(options?: {
  transport?: "auto" | "sse" | "websocket" | "websocket-cached";
}): OpenAIResponsesProviderHooks {
  return {
    buildReplayPolicy: buildOpenAIReplayPolicy,
    prepareExtraParams: (ctx) => defaultOpenAIResponsesExtraParams(ctx.extraParams, options),
    wrapStreamFn: wrapOpenAIResponsesProviderStreamFn,
    resolveTransportTurnState: resolveOpenAIResponsesTransportTurnState,
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

export { buildFirstTemplateModel, findCatalogTemplate, matchesExactOrPrefix };
