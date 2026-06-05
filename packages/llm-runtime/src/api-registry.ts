// LLM Runtime module implements api registry behavior.
import type {
  Api,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
} from "../../llm-core/src/index.js";

/** Runtime stream adapter signature stored in the API provider registry. */
export type ApiStreamFunction = (
  model: Model,
  context: Context,
  options?: StreamOptions,
) => AssistantMessageEventStreamContract;

/** Runtime simple-stream adapter signature stored in the API provider registry. */
export type ApiStreamSimpleFunction = (
  model: Model,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStreamContract;

/** Provider implementation registered by core or plugins for a specific model API. */
export interface ApiProvider<
  TApi extends Api = Api,
  TOptions extends StreamOptions = StreamOptions,
> {
  /** Model API id this provider handles. */
  api: TApi;
  /** Full streaming adapter for callers that already own structured options. */
  stream: StreamFunction<TApi, TOptions>;
  /** Simple streaming adapter used by agent and plugin runtime defaults. */
  streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

interface ApiProviderInternal {
  api: Api;
  stream: ApiStreamFunction;
  streamSimple: ApiStreamSimpleFunction;
}

type RegisteredApiProvider = {
  provider: ApiProviderInternal;
  sourceId?: string;
};

const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
  api: TApi,
  stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
  return (model, context, options) => {
    if (model.api !== api) {
      throw new Error(`Mismatched api: ${model.api} expected ${api}`);
    }
    return stream(model as Model<TApi>, context, options as TOptions);
  };
}

function wrapStreamSimple<TApi extends Api>(
  api: TApi,
  streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
  return (model, context, options) => {
    if (model.api !== api) {
      throw new Error(`Mismatched api: ${model.api} expected ${api}`);
    }
    return streamSimple(model as Model<TApi>, context, options);
  };
}

/** Registers or replaces the provider implementation for an API id. */
export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
  provider: ApiProvider<TApi, TOptions>,
  /** Optional source id used to unregister all providers owned by one plugin/runtime. */
  sourceId?: string,
): void {
  apiProviderRegistry.set(provider.api, {
    provider: {
      api: provider.api,
      stream: wrapStream(provider.api, provider.stream),
      streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
    },
    sourceId,
  });
}

/** Looks up a registered API provider by API id. */
export function getApiProvider(api: Api): ApiProviderInternal | undefined {
  return apiProviderRegistry.get(api)?.provider;
}

/** Lists all currently registered API providers. */
export function getApiProviders(): ApiProviderInternal[] {
  return Array.from(apiProviderRegistry.values(), (entry) => entry.provider);
}

/** Removes all providers registered by a plugin/source id. */
export function unregisterApiProviders(sourceId: string): void {
  for (const [api, entry] of apiProviderRegistry.entries()) {
    if (entry.sourceId === sourceId) {
      apiProviderRegistry.delete(api);
    }
  }
}

/** Clears the registry for test teardown and runtime reset flows. */
export function clearApiProviders(): void {
  apiProviderRegistry.clear();
}
