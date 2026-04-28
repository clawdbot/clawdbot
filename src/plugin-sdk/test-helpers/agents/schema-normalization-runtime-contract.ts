export function createParameterFreeTool(name = "ping") {
  return {
    name,
    description: "Parameter-free test tool",
    parameters: {},
  };
}

export function createStrictCompatibleTool(name = "lookup") {
  return {
    name,
    description: "Strict-compatible test tool",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };
}

export function createPermissiveTool(name = "schedule") {
  return {
    name,
    description: "Permissive test tool",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string" },
        cron: { type: "string" },
      },
      required: ["action"],
      additionalProperties: true,
    },
  };
}

export function createNativeOpenAIResponsesModel() {
  return {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

export function createNativeOpenAICodexResponsesModel() {
  return {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

export function createProxyOpenAIResponsesModel() {
  return {
    id: "custom-gpt",
    name: "Custom GPT",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://proxy.example.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

export function normalizedParameterFreeSchema() {
  return {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
}
