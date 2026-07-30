// Built-in provider registration installs lazy protocol adapters.
import type { ApiRegistry } from "../api-registry.js";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";

type ProviderStreams<TApi extends Api, TOptions extends StreamOptions> = {
  stream: StreamFunction<TApi, TOptions>;
  streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
};

type RegisterBuiltIn = (registry: ApiRegistry) => void;

/** Source id used for built-in API provider registrations. */
export const BUILT_IN_API_PROVIDER_SOURCE_ID = "core:built-in";

function forwardStream(
  target: AssistantMessageEventStream,
  source: AsyncIterable<AssistantMessageEvent>,
): void {
  void (async () => {
    for await (const event of source) {
      target.push(event);
    }
    target.end();
  })();
}

function createLazyLoadErrorMessage<TApi extends Api>(
  model: Model<TApi>,
  error: unknown,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

// Provider modules load on first use, while callers still receive a stream synchronously.
function createLazyStream<TApi extends Api, TOptions extends StreamOptions, TStreams>(
  load: () => Promise<TStreams>,
  select: (streams: TStreams) => StreamFunction<TApi, TOptions>,
): StreamFunction<TApi, TOptions> {
  return (model, context, options) => {
    const outer = new AssistantMessageEventStream();
    load()
      .then((streams) => forwardStream(outer, select(streams)(model, context, options)))
      .catch((error: unknown) => {
        const message = createLazyLoadErrorMessage(model, error);
        outer.push({ type: "error", reason: "error", error: message });
        outer.end(message);
      });
    return outer;
  };
}

function createLazyRegistration<TApi extends Api, TOptions extends StreamOptions, TModule>(
  api: TApi,
  importModule: () => Promise<TModule>,
  select: (module: TModule) => ProviderStreams<TApi, TOptions>,
): RegisterBuiltIn {
  let streamsPromise: Promise<ProviderStreams<TApi, TOptions>> | undefined;
  const load = () => (streamsPromise ??= importModule().then(select));
  const stream = createLazyStream(load, (streams) => streams.stream);
  const streamSimple = createLazyStream<TApi, SimpleStreamOptions, ProviderStreams<TApi, TOptions>>(
    load,
    (streams) => streams.streamSimple,
  );
  return (registry) => {
    registry.registerApiProvider({ api, stream, streamSimple }, BUILT_IN_API_PROVIDER_SOURCE_ID);
  };
}

const registerBuiltIns: RegisterBuiltIn[] = [
  // Registration is transport-free; each lazy adapter owns its fetch or construction unwrap.
  createLazyRegistration(
    "anthropic-messages",
    () => import("./anthropic.js"),
    (module) => ({ stream: module.streamAnthropic, streamSimple: module.streamSimpleAnthropic }),
  ),
  createLazyRegistration(
    "openai-completions",
    () => import("./openai-completions.js"),
    (module) => ({
      stream: module.streamOpenAICompletions,
      streamSimple: module.streamSimpleOpenAICompletions,
    }),
  ),
  createLazyRegistration(
    "mistral-conversations",
    () => import("./mistral.js"),
    (module) => ({ stream: module.streamMistral, streamSimple: module.streamSimpleMistral }),
  ),
  createLazyRegistration(
    "openai-responses",
    () => import("./openai-responses.js"),
    (module) => ({
      stream: module.streamOpenAIResponses,
      streamSimple: module.streamSimpleOpenAIResponses,
    }),
  ),
  createLazyRegistration(
    "azure-openai-responses",
    () => import("./azure-openai-responses.js"),
    (module) => ({
      stream: module.streamAzureOpenAIResponses,
      streamSimple: module.streamSimpleAzureOpenAIResponses,
    }),
  ),
  createLazyRegistration(
    "openai-chatgpt-responses",
    () => import("./openai-chatgpt-responses.js"),
    (module) => ({
      stream: module.streamOpenAICodexResponses,
      streamSimple: module.streamSimpleOpenAICodexResponses,
    }),
  ),
  createLazyRegistration(
    "google-generative-ai",
    () => import("./google.js"),
    (module) => ({ stream: module.streamGoogle, streamSimple: module.streamSimpleGoogle }),
  ),
  createLazyRegistration(
    "google-vertex",
    () => import("./google-vertex.js"),
    (module) => ({
      stream: module.streamGoogleVertex,
      streamSimple: module.streamSimpleGoogleVertex,
    }),
  ),
];

/** Registers every built-in API provider in one runtime registry. */
export function registerBuiltInApiProviders(registry: ApiRegistry): void {
  for (const register of registerBuiltIns) {
    register(registry);
  }
}

/** Restores the built-in provider registry state for tests. */
export function resetApiProviders(registry: ApiRegistry): void {
  registry.unregisterApiProviders(BUILT_IN_API_PROVIDER_SOURCE_ID);
  registerBuiltInApiProviders(registry);
}
