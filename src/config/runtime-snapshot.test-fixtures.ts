import type { OpenClawConfig } from "./types.js";
import type { SecretInput } from "./types.secrets.js";

export function createProviderConfigFixture(
  apiKey: SecretInput = { source: "env", provider: "default", id: "OPENAI_API_KEY" },
): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey,
          models: [],
        },
      },
    },
  };
}
