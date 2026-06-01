import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
  StreamOptions,
} from "../../llm-core/src/index.js";
import { getApiProvider } from "./api-registry.js";

function resolveApiProvider(api: Api) {
  const provider = getApiProvider(api);
  if (!provider) {
    throw new Error(`No API provider registered for api: ${api}`);
  }
  return provider;
}

/** Streams a provider turn through the registered implementation for the model API. */
export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): AssistantMessageEventStreamContract {
  const provider = resolveApiProvider(model.api);
  return provider.stream(model, context, options as StreamOptions);
}

/** Runs a provider turn and resolves the final assistant message result. */
export async function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
  const s = stream(model, context, options);
  return s.result();
}

/** Streams a simple provider turn through the registered implementation for the model API. */
export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStreamContract {
  const provider = resolveApiProvider(model.api);
  return provider.streamSimple(model, context, options);
}

/** Runs a simple provider turn and resolves the final assistant message result. */
export async function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  const s = streamSimple(model, context, options);
  return s.result();
}
