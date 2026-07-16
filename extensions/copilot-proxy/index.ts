import {
  definePluginEntry,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "./runtime-api.js";

const DEFAULT_BASE_URL = "http://localhost:3000/v1";
const DEFAULT_API_KEY = "n/a";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_MODEL_IDS = [
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5-mini",
  "claude-opus-4.6",
  "claude-opus-4.5",
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  "gemini-3-pro",
  "gemini-3-flash",
  "grok-code-fast-1",
] as const;

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_BASE_URL;
  }
  let normalized = trimmed;
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (!normalized.endsWith("/v1")) {
    normalized = `${normalized}/v1`;
  }
  return normalized;
}

function validateBaseUrl(value: string): string | undefined {
  const normalized = normalizeBaseUrl(value);
  return URL.canParse(normalized) ? undefined : "Enter a valid URL";
}

function parseModelIds(input: string): string[] {
  const parsed = input
    .split(/[\n,]/)
    .map((model) => model.trim())
    .filter(Boolean);
  return Array.from(new Set(parsed));
}

function buildModelDefinition(modelId: string) {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions" as const,
    reasoning: false,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

export default definePluginEntry({
  id: "copilot-proxy",
  name: "Copilot Proxy",
  description: "Local Copilot Proxy (VS Code LM) provider plugin",
  register(api) {
    api.registerProvider({
      id: "copilot-proxy",
      label: "Copilot Proxy",
      docsPath: "/providers/models",
      auth: [
        {
          id: "local",
          label: "Local proxy",
          hint: "Configure base URL + models for the Copilot Proxy server",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const baseUrlInput = await ctx.prompter.text({
              message: "Copilot Proxy base URL",
              initialValue: DEFAULT_BASE_URL,
              validate: validateBaseUrl,
            });

            const modelInput = await ctx.prompter.text({
              message: "Model IDs (comma-separated)",
              initialValue: DEFAULT_MODEL_IDS.join(", "),
              validate: (value: string) =>
                parseModelIds(value).length > 0 ? undefined : "Enter at least one model id",
            });

            const baseUrl = normalizeBaseUrl(baseUrlInput);
            const modelIds = parseModelIds(modelInput);
            const defaultModelId = modelIds[0] ?? DEFAULT_MODEL_IDS[0];
            const defaultModelRef = `copilot-proxy/${defaultModelId}`;

            return {
              profiles: [
                {
                  profileId: "copilot-proxy:local",
                  credential: {
                    type: "token",
                    provider: "copilot-proxy",
                    token: DEFAULT_API_KEY,
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    "copilot-proxy": {
                      baseUrl,
                      apiKey: DEFAULT_API_KEY,
                      api: "openai-completions",
                      authHeader: false,
                      models: modelIds.map((modelId) => buildModelDefinition(modelId)),
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: Object.fromEntries(
                      modelIds.map((modelId) => [`copilot-proxy/${modelId}`, {}]),
                    ),
                  },
                },
              },
              defaultModel: defaultModelRef,
              notes: [
                "Start the Copilot Proxy VS Code extension before using these models.",
                "Copilot Proxy serves /v1/chat/completions; base URL must include /v1.",
                "Model availability depends on your Copilot plan; edit models.providers.copilot-proxy if needed.",
              ],
            };
          },
        },
      ],
      wizard: {
        setup: {
          choiceId: "copilot-proxy",
          choiceLabel: "Copilot Proxy",
          choiceHint: "Configure base URL + model ids",
          methodId: "local",
        },
      },
    });
  },
});
