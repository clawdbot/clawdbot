import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

const POE_BASE_URL = "https://api.poe.com/v1";
const ENV_VAR = "POE_API_KEY";

// Poe model definitions - IDs match api.poe.com/v1/models
const POE_MODELS = [
  // Claude models
  {
    id: "claude-opus-4.5",
    name: "Claude Opus 4.5",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 200_000,
    maxTokens: 8192,
  },
  {
    id: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 200_000,
    maxTokens: 8192,
  },
  {
    id: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 200_000,
    maxTokens: 8192,
  },
  {
    id: "claude-code",
    name: "Claude Code",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 200_000,
    maxTokens: 8192,
  },
  // GPT models
  {
    id: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: "gpt-5.1-codex",
    name: "GPT-5.1 Codex",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: "gpt-5.1-codex-mini",
    name: "GPT-5.1 Codex Mini",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: "gpt-5.1-codex-max",
    name: "GPT-5.1 Codex Max",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: "o3-pro",
    name: "o3 Pro",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  // Gemini models
  {
    id: "gemini-3-pro",
    name: "Gemini 3 Pro",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128_000,
    maxTokens: 8192,
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128_000,
    maxTokens: 8192,
  },
  // Other models
  {
    id: "grok-4",
    name: "Grok 4",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128_000,
    maxTokens: 8192,
  },
  {
    id: "deepseek-r1",
    name: "DeepSeek R1",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 128_000,
    maxTokens: 8192,
  },
  {
    id: "deepseek-v3.2",
    name: "DeepSeek V3.2",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 128_000,
    maxTokens: 8192,
  },
] as const;

function buildModelDefinition(model: (typeof POE_MODELS)[number]) {
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions" as const,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

/**
 * Validates a Poe API key by making a test request to the models endpoint.
 */
export async function validatePoeApiKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${POE_BASE_URL}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

const poePlugin = {
  id: "poe",
  name: "Poe",
  description: "Poe API provider plugin (api.poe.com)",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerProvider({
      id: "poe",
      label: "Poe",
      docsPath: "/providers/poe",
      envVars: [ENV_VAR],
      auth: [
        {
          id: "api_key",
          label: "API Key",
          hint: "Enter your Poe API key from poe.com/api_key",
          kind: "api_key",
          run: async (ctx) => {
            const apiKeyInput = await ctx.prompter.text({
              message: "Poe API key (from poe.com/api_key)",
              validate: (value) => {
                const trimmed = value.trim();
                if (!trimmed) return "API key is required";
                return undefined;
              },
            });

            const apiKey = apiKeyInput.trim();
            const spin = ctx.prompter.progress("Validating Poe API key...");

            const isValid = await validatePoeApiKey(apiKey);
            if (!isValid) {
              spin.stop("Validation failed");
              throw new Error(
                "Invalid API key. Get a valid key from https://poe.com/api_key",
              );
            }

            spin.stop("API key validated");

            // Let user pick a default model
            const modelChoices = POE_MODELS.map((m) => ({
              value: m.id,
              label: m.name,
            }));

            const selectedModel = await ctx.prompter.select({
              message: "Select a default model",
              options: modelChoices,
            });

            const defaultModelRef = `poe/${selectedModel}`;

            return {
              profiles: [
                {
                  profileId: "poe:default",
                  credential: {
                    type: "token",
                    provider: "poe",
                    token: apiKey,
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    poe: {
                      baseUrl: POE_BASE_URL,
                      apiKey,
                      api: "openai-completions",
                      models: POE_MODELS.map((m) => buildModelDefinition(m)),
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: Object.fromEntries(
                      POE_MODELS.map((m) => [`poe/${m.id}`, {}]),
                    ),
                  },
                },
              },
              defaultModel: defaultModelRef,
              notes: [
                "Poe API has a rate limit of 500 requests per minute.",
                "Bot names are used as model IDs (e.g., Claude-Sonnet-4.5).",
                "Access additional bots by adding them to models.providers.poe.models.",
              ],
            };
          },
        },
      ],
    });
  },
};

export default poePlugin;
