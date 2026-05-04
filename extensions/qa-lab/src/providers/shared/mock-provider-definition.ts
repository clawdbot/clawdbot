import { createMockProviderMap } from "./mock-model-config.js";
import type { QaProviderDefinition, QaProviderMode } from "./types.js";

type MockQaProviderDefinitionParams = {
  mode: Extract<QaProviderMode, "aimock" | "mock-openai">;
  commandName: string;
  commandDescription: string;
  serverLabel: string;
  mockAuthProviders: readonly string[];
};

function mockModelRef(providerId: string, alternate?: boolean) {
  return `${providerId}/${alternate ? "gpt-5.5-alt" : "gpt-5.5"}`;
}

export function createMockQaProviderDefinition(
  params: MockQaProviderDefinitionParams,
): QaProviderDefinition {
  return {
    mode: params.mode,
    kind: "mock",
    standaloneCommand: {
      name: params.commandName,
      description: params.commandDescription,
      serverLabel: params.serverLabel,
    },
    defaultModel: (options) => mockModelRef(params.mode, options?.alternate),
    defaultImageGenerationProviderIds: ["openai"],
    defaultImageGenerationModel: ({ modelProviderIds }) =>
      modelProviderIds.includes("openai") ? "openai/gpt-image-1" : null,
    usesFastModeByDefault: () => false,
    resolveModelParams: () => ({
      transport: "sse",
      openaiWsWarmup: false,
    }),
    resolveTurnTimeoutMs: ({ fallbackMs }) => fallbackMs,
    buildGatewayModels: ({ providerBaseUrl }) => ({
      mode: "replace",
      providers: createMockProviderMap(params.mode, providerBaseUrl),
    }),
    mockAuthProviders: params.mockAuthProviders,
    usesModelProviderPlugins: false,
    scrubsLiveProviderEnv: true,
    appliesLiveEnvAliases: false,
  };
}
