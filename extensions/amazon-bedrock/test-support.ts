type BedrockStreamTestApi = {
  buildAdditionalModelRequestFields: (
    model: unknown,
    options: Record<string, unknown>,
  ) => Record<string, unknown> | undefined;
  convertMessages: (...args: unknown[]) => Array<{ content?: unknown; role?: unknown }>;
  getConfiguredBedrockRegion: (params: unknown) => string | undefined;
  hasConfiguredBedrockProfile: (params: unknown) => boolean;
  mapThinkingLevelToEffort: (model: unknown, level: unknown) => string;
  resolveSimpleBedrockOptions: (
    model: unknown,
    options: Record<string, unknown>,
  ) => Record<string, unknown>;
  shouldUseExplicitBedrockEndpoint: (...args: unknown[]) => boolean;
};

function requireTestApi(key: string): object {
  const api = Reflect.get(globalThis, Symbol.for(key));
  if (!api) {
    throw new Error(`${key} is unavailable`);
  }
  return api as object;
}

function lazyTestApi(key: string): object {
  return new Proxy(
    {},
    {
      get: (_target, property) => Reflect.get(requireTestApi(key), property),
    },
  );
}

export const streamTesting = lazyTestApi(
  "openclaw.amazonBedrockStreamTestApi",
) as BedrockStreamTestApi;
