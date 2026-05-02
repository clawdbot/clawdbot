import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import type { QaThinkingLevel } from "../../qa-thinking.js";

export type QaProviderMode = "mock-openai" | "aimock" | "live-frontier";
export type QaProviderModeInput = QaProviderMode;

export type QaMockProviderServer = {
  baseUrl: string;
  stop(): Promise<void>;
};

type QaProviderModelParamsInput = {
  modelRef: string;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
};

type QaProviderGatewayModelsInput = {
  providerBaseUrl: string;
  liveProviderConfigs?: Record<string, ModelProviderConfig>;
};

type QaProviderDefaultImageInput = {
  modelProviderIds: readonly string[];
};

type QaProviderTurnTimeoutInput = {
  primaryModel: string;
  alternateModel: string;
  modelRef: string;
  fallbackMs: number;
};

export type QaProviderDefinition = {
  mode: QaProviderMode;
  kind: "mock" | "live";
  standaloneCommand?: {
    name: string;
    description: string;
    serverLabel: string;
  };
  defaultModel(options?: { alternate?: boolean; preferredLiveModel?: string }): string;
  defaultImageGenerationProviderIds: readonly string[];
  defaultImageGenerationModel(input: QaProviderDefaultImageInput): string | null;
  usesFastModeByDefault(modelRef: string): boolean;
  resolveModelParams(input: QaProviderModelParamsInput): Record<string, unknown>;
  resolveTurnTimeoutMs(input: QaProviderTurnTimeoutInput): number;
  buildGatewayModels(input: QaProviderGatewayModelsInput): {
    mode: "replace" | "merge";
    providers: Record<string, ModelProviderConfig>;
  } | null;
  mockAuthProviders?: readonly string[];
  usesModelProviderPlugins: boolean;
  scrubsLiveProviderEnv: boolean;
  appliesLiveEnvAliases: boolean;
};
