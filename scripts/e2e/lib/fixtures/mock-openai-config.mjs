// Mock OpenAI model config helpers for E2E fixture generation.
export function applyMockOpenAiModelConfig(cfg, params) {
  const modelRef = params.modelRef ?? "openai/gpt-5.5";
  const modelId = modelRef.split("/").at(-1) ?? "gpt-5.5";
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  cfg.models = {
    ...cfg.models,
    mode: "merge",
    providers: {
      ...cfg.models?.providers,
      openai: {
        ...cfg.models?.providers?.openai,
        baseUrl: `http://127.0.0.1:${params.mockPort}/v1`,
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        api: "openai-responses",
        agentRuntime: { id: "openclaw" },
        request: { ...cfg.models?.providers?.openai?.request, allowPrivateNetwork: true },
        models: [
          {
            id: modelId,
            name: modelId,
            api: "openai-responses",
            agentRuntime: { id: "openclaw" },
            reasoning: false,
            input: ["text", "image"],
            cost,
            contextWindow: 128000,
            contextTokens: 96000,
            maxTokens: 4096,
          },
        ],
      },
    },
  };
  cfg.agents = {
    ...cfg.agents,
    defaults: {
      ...cfg.agents?.defaults,
      model: { primary: modelRef },
      ...(params.includeImageDefaults
        ? {
            imageModel: { primary: modelRef, timeoutMs: 30_000 },
            imageGenerationModel: { primary: "openai/gpt-image-1", timeoutMs: 30_000 },
          }
        : {}),
      models: {
        ...cfg.agents?.defaults?.models,
        [modelRef]: {
          agentRuntime: { id: "openclaw" },
          params: { transport: "sse", openaiWsWarmup: false },
        },
      },
    },
    ...(Array.isArray(cfg.agents?.list)
      ? {
          list: cfg.agents.list.map((agent) => ({
            ...agent,
            model: { ...agent.model, primary: modelRef },
            models: {
              ...agent.models,
              [modelRef]: {
                ...agent.models?.[modelRef],
                agentRuntime: { id: "openclaw" },
                params: {
                  ...agent.models?.[modelRef]?.params,
                  transport: "sse",
                  openaiWsWarmup: false,
                },
              },
            },
          })),
        }
      : {}),
  };
  cfg.plugins = {
    ...cfg.plugins,
    enabled: true,
  };
}
