import type { FoundryProviderApi } from "./shared.js";

type MicrosoftFoundryTestApi = {
  buildFoundryConnectionTest: (params: {
    endpoint: string;
    modelId: string;
    modelNameHint?: string | null;
    api: FoundryProviderApi;
  }) => { url: string; body: Record<string, unknown> };
  isAnthropicFoundryDeployment: (value?: string | null) => boolean;
  isValidTenantIdentifier: (value: string) => boolean;
  resetFoundryRuntimeAuthCaches: () => void;
  shouldTestFoundryTextConnection: (params: {
    modelId: string;
    modelNameHint?: string | null;
  }) => boolean;
  supportsFoundryImageInput: (value?: string | null) => boolean;
  supportsFoundryReasoningContent: (value?: string | null) => boolean;
  supportsFoundryReasoningEffort: (value?: string | null) => boolean;
};

const api = Reflect.get(globalThis, Symbol.for("openclaw.microsoftFoundryTestApi"));
if (!api) {
  throw new Error("Microsoft Foundry test API is unavailable");
}

export const microsoftFoundryTesting = api as MicrosoftFoundryTestApi;
