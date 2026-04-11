import fs from "node:fs/promises";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { createProviderApiKeyAuthMethod } from "../plugins/provider-api-key-auth.js";
import { providerApiKeyAuthRuntime } from "../plugins/provider-api-key-auth.runtime.js";
import type { ProviderAuthMethod, ProviderAuthResult, ProviderPlugin } from "../plugins/types.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoice, resolvePreferredProviderForAuthChoice } from "./auth-choice.js";
import type { AuthChoice } from "./onboard-types.js";
import {
  authProfilePathForAgent,
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  requireOpenClawAgentDir,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

type DetectZaiEndpoint = typeof import("../plugins/provider-zai-endpoint.js").detectZaiEndpoint;

const GOOGLE_GEMINI_DEFAULT_MODEL = "google/gemini-3.1-pro-preview";
const MINIMAX_CN_API_BASE_URL = "https://api.minimax.chat/v1";
const ZAI_CODING_GLOBAL_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ZAI_CODING_CN_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";

const loginOpenAICodexOAuth = vi.hoisted(() =>
  vi.fn<() => Promise<OAuthCredentials | null>>(async () => null),
);
vi.mock("../plugins/provider-openai-codex-oauth.js", () => ({
  loginOpenAICodexOAuth,
}));

const resolvePluginProviders = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
const runProviderModelSelectedHook = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../plugins/provider-auth-choice.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-auth-choice.runtime.js")>(
    "../plugins/provider-auth-choice.runtime.js",
  );
  return {
    ...actual,
    resolvePluginProviders,
    runProviderModelSelectedHook,
  };
});

const detectZaiEndpoint = vi.hoisted(() => vi.fn<DetectZaiEndpoint>(async () => null));
vi.mock("../plugins/provider-zai-endpoint.js", () => ({
  detectZaiEndpoint,
}));

type StoredAuthProfile = {
  key?: string;
  token?: string;
  keyRef?: { source: string; provider: string; id: string };
  access?: string;
  refresh?: string;
  provider?: string;
  type?: string;
  email?: string;
  metadata?: Record<string, string>;
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function providerConfigPatch(
  providerId: string,
  patch: Record<string, unknown>,
): Partial<OpenClawConfig> {
  const providers: Record<string, ModelProviderConfig> = {
    [providerId]: patch as ModelProviderConfig,
  };
  return {
    models: {
      providers,
    },
  };
}

function createApiKeyProvider(params: {
  providerId: string;
  label: string;
  choiceId: string;
  optionKey: string;
  flagName: `--${string}`;
  envVar: string;
  promptMessage: string;
  defaultModel?: string;
  profileId?: string;
  profileIds?: string[];
  expectedProviders?: string[];
  noteMessage?: string;
  noteTitle?: string;
  applyConfig?: Partial<OpenClawConfig>;
}): ProviderPlugin {
  return {
    id: params.providerId,
    label: params.label,
    auth: [
      createProviderApiKeyAuthMethod({
        providerId: params.providerId,
        methodId: "api-key",
        label: params.label,
        optionKey: params.optionKey,
        flagName: params.flagName,
        envVar: params.envVar,
        promptMessage: params.promptMessage,
        ...(params.profileId ? { profileId: params.profileId } : {}),
        ...(params.profileIds ? { profileIds: params.profileIds } : {}),
        ...(params.defaultModel ? { defaultModel: params.defaultModel } : {}),
        ...(params.expectedProviders ? { expectedProviders: params.expectedProviders } : {}),
        ...(params.noteMessage ? { noteMessage: params.noteMessage } : {}),
        ...(params.noteTitle ? { noteTitle: params.noteTitle } : {}),
        ...(params.applyConfig ? { applyConfig: () => params.applyConfig as OpenClawConfig } : {}),
        wizard: {
          choiceId: params.choiceId,
          choiceLabel: params.label,
          groupId: params.providerId,
          groupLabel: params.label,
        },
      }),
    ],
  };
}

function createFixedChoiceProvider(params: {
  providerId: string;
  label: string;
  choiceId: string;
  method: ProviderAuthMethod;
}): ProviderPlugin {
  return {
    id: params.providerId,
    label: params.label,
    auth: [
      {
        ...params.method,
        wizard: {
          choiceId: params.choiceId,
          choiceLabel: params.label,
          groupId: params.providerId,
          groupLabel: params.label,
        },
      },
    ],
  };
}

function createDefaultProviderPlugins() {
  const buildApiKeyCredential = providerApiKeyAuthRuntime.buildApiKeyCredential;
  const ensureApiKeyFromOptionEnvOrPrompt =
    providerApiKeyAuthRuntime.ensureApiKeyFromOptionEnvOrPrompt;
  const normalizeApiKeyInput = providerApiKeyAuthRuntime.normalizeApiKeyInput;
  const validateApiKeyInput = providerApiKeyAuthRuntime.validateApiKeyInput;

  const createZaiMethod = (choiceId: "zai-api-key" | "zai-coding-global"): ProviderAuthMethod => ({
    id: choiceId === "zai-api-key" ? "api-key" : "coding-global",
    label: "Z.AI API key",
    kind: "api_key",
    wizard: {
      choiceId,
      choiceLabel: "Z.AI API key",
      groupId: "zai",
      groupLabel: "Z.AI",
    },
    run: async (ctx) => {
      const token = normalizeText(await ctx.prompter.text({ message: "Enter Z.AI API key" }));
      const detectResult = await detectZaiEndpoint(
        choiceId === "zai-coding-global"
          ? { apiKey: token, endpoint: "coding-global" }
          : { apiKey: token },
      );
      let baseUrl = detectResult?.baseUrl;
      let modelId = detectResult?.modelId;
      if (!baseUrl || !modelId) {
        if (choiceId === "zai-coding-global") {
          baseUrl = ZAI_CODING_GLOBAL_BASE_URL;
          modelId = "glm-5";
        } else {
          const endpoint = await ctx.prompter.select({
            message: "Select Z.AI endpoint",
            initialValue: "global",
            options: [
              { label: "Global", value: "global" },
              { label: "Coding CN", value: "coding-cn" },
            ],
          });
          baseUrl = endpoint === "coding-cn" ? ZAI_CODING_CN_BASE_URL : ZAI_CODING_GLOBAL_BASE_URL;
          modelId = "glm-5";
        }
      }
      return {
        profiles: [
          {
            profileId: "zai:default",
            credential: buildApiKeyCredential("zai", token),
          },
        ],
        configPatch: providerConfigPatch("zai", { baseUrl }) as OpenClawConfig,
        defaultModel: `zai/${modelId}`,
      };
    },
  });

  const cloudflareAiGatewayMethod: ProviderAuthMethod = {
    id: "api-key",
    label: "Cloudflare AI Gateway API key",
    kind: "api_key",
    wizard: {
      choiceId: "cloudflare-ai-gateway-api-key",
      choiceLabel: "Cloudflare AI Gateway API key",
      groupId: "cloudflare-ai-gateway",
      groupLabel: "Cloudflare AI Gateway",
    },
    run: async (ctx) => {
      const opts = (ctx.opts ?? {}) as Record<string, unknown>;
      const accountId =
        normalizeText(opts.cloudflareAiGatewayAccountId) ||
        normalizeText(await ctx.prompter.text({ message: "Enter Cloudflare account ID" }));
      const gatewayId =
        normalizeText(opts.cloudflareAiGatewayGatewayId) ||
        normalizeText(await ctx.prompter.text({ message: "Enter Cloudflare gateway ID" }));
      let capturedSecretInput = "";
      let capturedMode: "plaintext" | "ref" | undefined;
      await ensureApiKeyFromOptionEnvOrPrompt({
        token:
          normalizeText(opts.cloudflareAiGatewayApiKey) ||
          normalizeText(ctx.opts?.token) ||
          undefined,
        tokenProvider: "cloudflare-ai-gateway",
        secretInputMode:
          ctx.allowSecretRefPrompt === false
            ? (ctx.secretInputMode ?? "plaintext")
            : ctx.secretInputMode,
        config: ctx.config,
        expectedProviders: ["cloudflare-ai-gateway"],
        provider: "cloudflare-ai-gateway",
        envLabel: "CLOUDFLARE_AI_GATEWAY_API_KEY",
        promptMessage: "Enter Cloudflare AI Gateway API key",
        normalize: normalizeApiKeyInput,
        validate: validateApiKeyInput,
        prompter: ctx.prompter,
        setCredential: async (apiKey, mode) => {
          capturedSecretInput = typeof apiKey === "string" ? apiKey : "";
          capturedMode = mode;
        },
      });
      return {
        profiles: [
          {
            profileId: "cloudflare-ai-gateway:default",
            credential: buildApiKeyCredential(
              "cloudflare-ai-gateway",
              capturedSecretInput,
              { accountId, gatewayId },
              capturedMode ? { secretInputMode: capturedMode } : undefined,
            ),
          },
        ],
        defaultModel: "cloudflare-ai-gateway/claude-sonnet-4-5",
      };
    },
  };

  const chutesOAuthMethod: ProviderAuthMethod = {
    id: "oauth",
    label: "Chutes OAuth",
    kind: "device_code",
    wizard: {
      choiceId: "chutes",
      choiceLabel: "Chutes",
      groupId: "chutes",
      groupLabel: "Chutes",
    },
    run: async (ctx) => {
      const state = "state-test";
      ctx.runtime.log(`Open this URL: https://api.chutes.ai/idp/authorize?state=${state}`);
      const redirect = await ctx.prompter.text({ message: "Paste the redirect URL or code" });
      const params = new URLSearchParams(redirect.startsWith("?") ? redirect.slice(1) : redirect);
      const code = params.get("code") ?? redirect;
      const tokenResponse = await fetch("https://api.chutes.ai/idp/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, client_id: process.env.CHUTES_CLIENT_ID }),
      });
      const tokenJson = (await tokenResponse.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };
      const userResponse = await fetch("https://api.chutes.ai/idp/userinfo", {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      const userJson = (await userResponse.json()) as { username: string };
      return {
        profiles: [
          {
            profileId: `chutes:${userJson.username}`,
            credential: {
              type: "oauth",
              provider: "chutes",
              access: tokenJson.access_token,
              refresh: tokenJson.refresh_token,
              expires: Date.now() + tokenJson.expires_in * 1000,
              email: userJson.username,
            },
          },
        ],
      };
    },
  };

  return [
    createApiKeyProvider({
      providerId: "anthropic",
      label: "Anthropic API key",
      choiceId: "apiKey",
      optionKey: "anthropicApiKey",
      flagName: "--anthropic-api-key",
      envVar: "ANTHROPIC_API_KEY",
      promptMessage: "Enter Anthropic API key",
    }),
    createApiKeyProvider({
      providerId: "google",
      label: "Gemini API key",
      choiceId: "gemini-api-key",
      optionKey: "geminiApiKey",
      flagName: "--gemini-api-key",
      envVar: "GEMINI_API_KEY",
      promptMessage: "Enter Gemini API key",
      defaultModel: GOOGLE_GEMINI_DEFAULT_MODEL,
    }),
    createApiKeyProvider({
      providerId: "huggingface",
      label: "Hugging Face API key",
      choiceId: "huggingface-api-key",
      optionKey: "huggingfaceApiKey",
      flagName: "--huggingface-api-key",
      envVar: "HUGGINGFACE_HUB_TOKEN",
      promptMessage: "Enter Hugging Face API key",
      defaultModel: "huggingface/Qwen/Qwen3-Coder-480B-A35B-Instruct",
    }),
    createApiKeyProvider({
      providerId: "litellm",
      label: "LiteLLM API key",
      choiceId: "litellm-api-key",
      optionKey: "litellmApiKey",
      flagName: "--litellm-api-key",
      envVar: "LITELLM_API_KEY",
      promptMessage: "Enter LiteLLM API key",
      defaultModel: "litellm/anthropic/claude-opus-4.6",
    }),
    createApiKeyProvider({
      providerId: "minimax",
      label: "MiniMax API key (Global)",
      choiceId: "minimax-global-api",
      optionKey: "minimaxApiKey",
      flagName: "--minimax-api-key",
      envVar: "MINIMAX_API_KEY",
      promptMessage: "Enter MiniMax API key",
      profileId: "minimax:global",
      defaultModel: "minimax/MiniMax-M2.7",
    }),
    createApiKeyProvider({
      providerId: "minimax",
      label: "MiniMax API key (CN)",
      choiceId: "minimax-cn-api",
      optionKey: "minimaxApiKey",
      flagName: "--minimax-api-key",
      envVar: "MINIMAX_API_KEY",
      promptMessage: "Enter MiniMax CN API key",
      profileId: "minimax:cn",
      defaultModel: "minimax/MiniMax-M2.7",
      applyConfig: providerConfigPatch("minimax", { baseUrl: MINIMAX_CN_API_BASE_URL }),
      expectedProviders: ["minimax", "minimax-cn"],
    }),
    createApiKeyProvider({
      providerId: "mistral",
      label: "Mistral API key",
      choiceId: "mistral-api-key",
      optionKey: "mistralApiKey",
      flagName: "--mistral-api-key",
      envVar: "MISTRAL_API_KEY",
      promptMessage: "Enter Mistral API key",
      defaultModel: "mistral/mistral-large-latest",
    }),
    createApiKeyProvider({
      providerId: "moonshot",
      label: "Moonshot API key",
      choiceId: "moonshot-api-key",
      optionKey: "moonshotApiKey",
      flagName: "--moonshot-api-key",
      envVar: "MOONSHOT_API_KEY",
      promptMessage: "Enter Moonshot API key",
      defaultModel: "moonshot/moonshot-v1-128k",
    }),
    createFixedChoiceProvider({
      providerId: "ollama",
      label: "Ollama",
      choiceId: "ollama",
      method: {
        id: "local",
        label: "Ollama",
        kind: "custom",
        run: async () => ({ profiles: [] }),
      },
    }),
    createApiKeyProvider({
      providerId: "openai",
      label: "OpenAI API key",
      choiceId: "openai-api-key",
      optionKey: "openaiApiKey",
      flagName: "--openai-api-key",
      envVar: "OPENAI_API_KEY",
      promptMessage: "Enter OpenAI API key",
      defaultModel: "openai/gpt-5.4",
    }),
    createApiKeyProvider({
      providerId: "opencode",
      label: "OpenCode Zen",
      choiceId: "opencode-zen",
      optionKey: "opencodeZenApiKey",
      flagName: "--opencode-zen-api-key",
      envVar: "OPENCODE_API_KEY",
      promptMessage: "Enter OpenCode API key",
      profileIds: ["opencode:default", "opencode-go:default"],
      defaultModel: "opencode/claude-opus-4-6",
      expectedProviders: ["opencode", "opencode-go"],
      noteMessage: "OpenCode uses one API key across the Zen and Go catalogs.",
      noteTitle: "OpenCode",
    }),
    createApiKeyProvider({
      providerId: "opencode-go",
      label: "OpenCode Go",
      choiceId: "opencode-go",
      optionKey: "opencodeGoApiKey",
      flagName: "--opencode-go-api-key",
      envVar: "OPENCODE_API_KEY",
      promptMessage: "Enter OpenCode API key",
      profileIds: ["opencode-go:default", "opencode:default"],
      defaultModel: "opencode-go/kimi-k2.5",
      expectedProviders: ["opencode", "opencode-go"],
      noteMessage: "OpenCode uses one API key across the Zen and Go catalogs.",
      noteTitle: "OpenCode",
    }),
    createApiKeyProvider({
      providerId: "openrouter",
      label: "OpenRouter API key",
      choiceId: "openrouter-api-key",
      optionKey: "openrouterApiKey",
      flagName: "--openrouter-api-key",
      envVar: "OPENROUTER_API_KEY",
      promptMessage: "Enter OpenRouter API key",
      defaultModel: "openrouter/auto",
    }),
    createApiKeyProvider({
      providerId: "qianfan",
      label: "Qianfan API key",
      choiceId: "qianfan-api-key",
      optionKey: "qianfanApiKey",
      flagName: "--qianfan-api-key",
      envVar: "QIANFAN_API_KEY",
      promptMessage: "Enter Qianfan API key",
      defaultModel: "qianfan/ernie-4.5-8k",
    }),
    createApiKeyProvider({
      providerId: "synthetic",
      label: "Synthetic API key",
      choiceId: "synthetic-api-key",
      optionKey: "syntheticApiKey",
      flagName: "--synthetic-api-key",
      envVar: "SYNTHETIC_API_KEY",
      promptMessage: "Enter Synthetic API key",
      defaultModel: "synthetic/Synthetic-1",
    }),
    createApiKeyProvider({
      providerId: "together",
      label: "Together API key",
      choiceId: "together-api-key",
      optionKey: "togetherApiKey",
      flagName: "--together-api-key",
      envVar: "TOGETHER_API_KEY",
      promptMessage: "Enter Together API key",
      defaultModel: "together/meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
    }),
    createApiKeyProvider({
      providerId: "venice",
      label: "Venice AI",
      choiceId: "venice-api-key",
      optionKey: "veniceApiKey",
      flagName: "--venice-api-key",
      envVar: "VENICE_API_KEY",
      promptMessage: "Enter Venice AI API key",
      defaultModel: "venice/venice-uncensored",
      noteMessage: "Venice is a privacy-focused inference service.",
      noteTitle: "Venice AI",
    }),
    createApiKeyProvider({
      providerId: "vercel-ai-gateway",
      label: "AI Gateway API key",
      choiceId: "ai-gateway-api-key",
      optionKey: "aiGatewayApiKey",
      flagName: "--ai-gateway-api-key",
      envVar: "AI_GATEWAY_API_KEY",
      promptMessage: "Enter AI Gateway API key",
      defaultModel: "vercel-ai-gateway/anthropic/claude-opus-4.6",
    }),
    createApiKeyProvider({
      providerId: "xai",
      label: "xAI API key",
      choiceId: "xai-api-key",
      optionKey: "xaiApiKey",
      flagName: "--xai-api-key",
      envVar: "XAI_API_KEY",
      promptMessage: "Enter xAI API key",
      defaultModel: "xai/grok-4",
    }),
    createApiKeyProvider({
      providerId: "xiaomi",
      label: "Xiaomi API key",
      choiceId: "xiaomi-api-key",
      optionKey: "xiaomiApiKey",
      flagName: "--xiaomi-api-key",
      envVar: "XIAOMI_API_KEY",
      promptMessage: "Enter Xiaomi API key",
      defaultModel: "xiaomi/mimo-v2-flash",
    }),
    {
      id: "zai",
      label: "Z.AI",
      auth: [createZaiMethod("zai-api-key"), createZaiMethod("zai-coding-global")],
    },
    {
      id: "cloudflare-ai-gateway",
      label: "Cloudflare AI Gateway",
      auth: [cloudflareAiGatewayMethod],
    },
    {
      id: "chutes",
      label: "Chutes",
      auth: [chutesOAuthMethod],
    },
    createApiKeyProvider({
      providerId: "kimi",
      label: "Kimi Code API key",
      choiceId: "kimi-code-api-key",
      optionKey: "kimiApiKey",
      flagName: "--kimi-api-key",
      envVar: "KIMI_API_KEY",
      promptMessage: "Enter Kimi Code API key",
      defaultModel: "kimi/kimi-k2.5",
      expectedProviders: ["kimi", "kimi-code", "kimi-coding"],
    }),
    createFixedChoiceProvider({
      providerId: "github-copilot",
      label: "GitHub Copilot",
      choiceId: "github-copilot",
      method: {
        id: "device",
        label: "GitHub device login",
        kind: "device_code",
        run: async () => ({ profiles: [] }),
      },
    }),
  ];
}

describe("applyAuthChoice", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "HF_TOKEN",
    "HUGGINGFACE_HUB_TOKEN",
    "LITELLM_API_KEY",
    "AI_GATEWAY_API_KEY",
    "CLOUDFLARE_AI_GATEWAY_API_KEY",
    "MOONSHOT_API_KEY",
    "MISTRAL_API_KEY",
    "KIMI_API_KEY",
    "GEMINI_API_KEY",
    "XIAOMI_API_KEY",
    "VENICE_API_KEY",
    "OPENCODE_API_KEY",
    "TOGETHER_API_KEY",
    "QIANFAN_API_KEY",
    "SYNTHETIC_API_KEY",
    "SSH_TTY",
    "CHUTES_CLIENT_ID",
  ]);
  let activeStateDir: string | null = null;
  async function setupTempState() {
    if (activeStateDir) {
      await fs.rm(activeStateDir, { recursive: true, force: true });
    }
    const env = await setupAuthTestEnv("openclaw-auth-");
    activeStateDir = env.stateDir;
    lifecycle.setStateDir(env.stateDir);
  }
  function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
    return createWizardPrompter(overrides, { defaultSelect: "" });
  }
  function createSelectFirstOption(): WizardPrompter["select"] {
    return vi.fn(async (params) => params.options[0]?.value as never);
  }
  function createNoopMultiselect(): WizardPrompter["multiselect"] {
    return vi.fn(async () => []);
  }
  function createApiKeyPromptHarness(
    overrides: Partial<Pick<WizardPrompter, "select" | "multiselect" | "text" | "confirm">> = {},
  ): {
    select: WizardPrompter["select"];
    multiselect: WizardPrompter["multiselect"];
    prompter: WizardPrompter;
    runtime: ReturnType<typeof createExitThrowingRuntime>;
  } {
    const select = overrides.select ?? createSelectFirstOption();
    const multiselect = overrides.multiselect ?? createNoopMultiselect();
    return {
      select,
      multiselect,
      prompter: createPrompter({ ...overrides, select, multiselect }),
      runtime: createExitThrowingRuntime(),
    };
  }
  async function readAuthProfiles() {
    return await readAuthProfilesForAgent<{
      profiles?: Record<string, StoredAuthProfile>;
    }>(requireOpenClawAgentDir());
  }
  async function readAuthProfile(profileId: string) {
    return (await readAuthProfiles()).profiles?.[profileId];
  }

  afterEach(async () => {
    vi.unstubAllGlobals();
    resolvePluginProviders.mockReset();
    resolvePluginProviders.mockReturnValue(createDefaultProviderPlugins());
    runProviderModelSelectedHook.mockClear();
    detectZaiEndpoint.mockReset();
    detectZaiEndpoint.mockResolvedValue(null);
    loginOpenAICodexOAuth.mockReset();
    loginOpenAICodexOAuth.mockResolvedValue(null);
    await lifecycle.cleanup();
    activeStateDir = null;
  });

  resolvePluginProviders.mockReturnValue(createDefaultProviderPlugins());

  it("applies Anthropic setup-token auth when the provider exposes the setup flow", async () => {
    await setupTempState();

    resolvePluginProviders.mockReturnValue([
      createFixedChoiceProvider({
        providerId: "anthropic",
        label: "Anthropic",
        choiceId: "setup-token",
        method: {
          id: "setup-token",
          label: "Anthropic setup-token",
          kind: "token",
          run: vi.fn(
            async (): Promise<ProviderAuthResult> => ({
              profiles: [
                {
                  profileId: "anthropic:default",
                  credential: {
                    type: "token",
                    provider: "anthropic",
                    token: `sk-ant-oat01-${"a".repeat(80)}`,
                  },
                },
              ],
              defaultModel: "anthropic/claude-sonnet-4-6",
            }),
          ),
        },
      }),
    ]);

    const result = await applyAuthChoice({
      authChoice: "token",
      config: {} as OpenClawConfig,
      prompter: createPrompter({}),
      runtime: createExitThrowingRuntime(),
      setDefaultModel: true,
      opts: {
        tokenProvider: "anthropic",
        token: `sk-ant-oat01-${"a".repeat(80)}`,
      },
    });

    expect(result.config.auth?.profiles?.["anthropic:default"]).toMatchObject({
      provider: "anthropic",
      mode: "token",
    });
    expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect((await readAuthProfile("anthropic:default"))?.token).toBe(
      `sk-ant-oat01-${"a".repeat(80)}`,
    );
  });

  it("does not throw when openai-codex oauth fails", async () => {
    await setupTempState();

    loginOpenAICodexOAuth.mockRejectedValueOnce(new Error("oauth failed"));
    resolvePluginProviders.mockReturnValue([
      {
        id: "openai-codex",
        label: "OpenAI Codex",
        auth: [
          {
            id: "oauth",
            label: "ChatGPT OAuth",
            kind: "oauth",
            run: vi.fn(async () => {
              try {
                await loginOpenAICodexOAuth();
              } catch {
                return { profiles: [] };
              }
              return { profiles: [] };
            }),
          },
        ],
      },
    ] as never);

    const prompter = createPrompter({});
    const runtime = createExitThrowingRuntime();

    await expect(
      applyAuthChoice({
        authChoice: "openai-codex",
        config: {},
        prompter,
        runtime,
        setDefaultModel: false,
      }),
    ).resolves.toEqual({ config: {} });
  });

  it("stores openai-codex OAuth with email profile id", async () => {
    await setupTempState();

    loginOpenAICodexOAuth.mockResolvedValueOnce({
      email: "user@example.com",
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    });
    resolvePluginProviders.mockReturnValue([
      {
        id: "openai-codex",
        label: "OpenAI Codex",
        auth: [
          {
            id: "oauth",
            label: "ChatGPT OAuth",
            kind: "oauth",
            run: vi.fn(async () => {
              const creds = await loginOpenAICodexOAuth();
              if (!creds) {
                return { profiles: [] };
              }
              return {
                profiles: [
                  {
                    profileId: "openai-codex:user@example.com",
                    credential: {
                      type: "oauth",
                      provider: "openai-codex",
                      refresh: "refresh-token",
                      access: "access-token",
                      expires: creds.expires,
                      email: "user@example.com",
                    },
                  },
                ],
                defaultModel: "openai-codex/gpt-5.4",
              };
            }),
          },
        ],
      },
    ] as never);

    const prompter = createPrompter({});
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "openai-codex",
      config: {},
      prompter,
      runtime,
      setDefaultModel: false,
    });

    expect(result.config.auth?.profiles?.["openai-codex:user@example.com"]).toMatchObject({
      provider: "openai-codex",
      mode: "oauth",
    });
    expect(result.config.auth?.profiles?.["openai-codex:default"]).toBeUndefined();
    expect(await readAuthProfile("openai-codex:user@example.com")).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      refresh: "refresh-token",
      access: "access-token",
      email: "user@example.com",
    });
  });

  it("prompts and writes provider API key profiles for common providers", async () => {
    const scenarios: Array<{
      authChoice:
        | "minimax-global-api"
        | "minimax-cn-api"
        | "synthetic-api-key"
        | "huggingface-api-key";
      promptContains: string;
      profileId: string;
      provider: string;
      token: string;
    }> = [
      {
        authChoice: "minimax-global-api" as const,
        promptContains: "Enter MiniMax API key",
        profileId: "minimax:global",
        provider: "minimax",
        token: "sk-minimax-test",
      },
      {
        authChoice: "minimax-cn-api" as const,
        promptContains: "Enter MiniMax CN API key",
        profileId: "minimax:cn",
        provider: "minimax",
        token: "sk-minimax-test",
      },
      {
        authChoice: "synthetic-api-key" as const,
        promptContains: "Enter Synthetic API key",
        profileId: "synthetic:default",
        provider: "synthetic",
        token: "sk-synthetic-test",
      },
      {
        authChoice: "huggingface-api-key" as const,
        promptContains: "Hugging Face",
        profileId: "huggingface:default",
        provider: "huggingface",
        token: "hf-test-token",
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();

      const text = vi.fn().mockResolvedValue(scenario.token);
      const { prompter, runtime } = createApiKeyPromptHarness({ text });

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
      });

      expect(text).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining(scenario.promptContains) }),
      );
      expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
        provider: scenario.provider,
        mode: "api_key",
      });
      expect((await readAuthProfile(scenario.profileId))?.key).toBe(scenario.token);
    }
  });

  it("uses Z.AI endpoint detection and prompts in the auth flow", async () => {
    const scenarios: Array<{
      authChoice: "zai-api-key" | "zai-coding-global";
      token: string;
      endpointSelection?: "coding-cn" | "global";
      detectResult?: {
        endpoint: "coding-global" | "coding-cn";
        modelId: string;
        baseUrl: string;
        note: string;
      };
      shouldPromptForEndpoint: boolean;
      expectedDetectCall?: { apiKey: string; endpoint?: "coding-global" | "coding-cn" };
    }> = [
      {
        authChoice: "zai-api-key",
        token: "zai-test-key",
        endpointSelection: "coding-cn",
        shouldPromptForEndpoint: true,
      },
      {
        authChoice: "zai-coding-global",
        token: "zai-test-key",
        detectResult: {
          endpoint: "coding-global",
          modelId: "glm-4.7",
          baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
          note: "Detected coding-global endpoint with GLM-4.7 fallback",
        },
        shouldPromptForEndpoint: false,
        expectedDetectCall: { apiKey: "zai-test-key", endpoint: "coding-global" },
      },
      {
        authChoice: "zai-api-key",
        token: "zai-detected-key",
        detectResult: {
          endpoint: "coding-global",
          modelId: "glm-4.5",
          baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
          note: "Detected coding-global endpoint",
        },
        shouldPromptForEndpoint: false,
        expectedDetectCall: { apiKey: "zai-detected-key" },
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();
      detectZaiEndpoint.mockReset();
      detectZaiEndpoint.mockResolvedValue(null);
      if (scenario.detectResult) {
        detectZaiEndpoint.mockResolvedValueOnce(scenario.detectResult);
      }

      const text = vi.fn().mockResolvedValue(scenario.token);
      const select = vi.fn(async (params: { message: string }) => {
        if (params.message === "Select Z.AI endpoint") {
          return scenario.endpointSelection ?? "global";
        }
        return "default";
      });
      const { prompter, runtime } = createApiKeyPromptHarness({
        select: select as WizardPrompter["select"],
        text,
      });

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
      });

      if (scenario.expectedDetectCall) {
        expect(detectZaiEndpoint).toHaveBeenCalledWith(scenario.expectedDetectCall);
      }
      if (scenario.shouldPromptForEndpoint) {
        expect(select).toHaveBeenCalledWith(
          expect.objectContaining({ message: "Select Z.AI endpoint", initialValue: "global" }),
        );
      } else {
        expect(select).not.toHaveBeenCalledWith(
          expect.objectContaining({ message: "Select Z.AI endpoint" }),
        );
      }
      expect(result.config.auth?.profiles?.["zai:default"]).toMatchObject({
        provider: "zai",
        mode: "api_key",
      });
      expect((await readAuthProfile("zai:default"))?.key).toBe(scenario.token);
    }
  });

  it("maps apiKey tokenProvider aliases to provider flow", async () => {
    const scenarios: Array<{
      tokenProvider: string;
      token: string;
      profileId: string;
      provider: string;
      expectedModel?: string;
      expectedModelPrefix?: string;
    }> = [
      {
        tokenProvider: "huggingface",
        token: "hf-token-provider-test",
        profileId: "huggingface:default",
        provider: "huggingface",
        expectedModelPrefix: "huggingface/",
      },
      {
        tokenProvider: "  ToGeThEr  ",
        token: "sk-together-token-provider-test",
        profileId: "together:default",
        provider: "together",
        expectedModelPrefix: "together/",
      },
      {
        tokenProvider: "KIMI-CODING",
        token: "sk-kimi-token-provider-test",
        profileId: "kimi:default",
        provider: "kimi",
        expectedModelPrefix: "kimi/",
      },
      {
        tokenProvider: " GOOGLE  ",
        token: "sk-gemini-token-provider-test",
        profileId: "google:default",
        provider: "google",
        expectedModel: GOOGLE_GEMINI_DEFAULT_MODEL,
      },
      {
        tokenProvider: " LITELLM  ",
        token: "sk-litellm-token-provider-test",
        profileId: "litellm:default",
        provider: "litellm",
        expectedModelPrefix: "litellm/",
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();
      delete process.env.HF_TOKEN;
      delete process.env.HUGGINGFACE_HUB_TOKEN;

      const text = vi.fn().mockResolvedValue("should-not-be-used");
      const confirm = vi.fn(async () => false);
      const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

      const result = await applyAuthChoice({
        authChoice: "apiKey",
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
        opts: {
          tokenProvider: scenario.tokenProvider,
          token: scenario.token,
        },
      });

      expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
        provider: scenario.provider,
        mode: "api_key",
      });
      if (scenario.expectedModel) {
        expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
          scenario.expectedModel,
        );
      }
      if (scenario.expectedModelPrefix) {
        expect(
          resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)?.startsWith(
            scenario.expectedModelPrefix,
          ),
        ).toBe(true);
      }
      expect(text).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect((await readAuthProfile(scenario.profileId))?.key).toBe(scenario.token);
    }
  });

  it.each([
    {
      authChoice: "moonshot-api-key",
      tokenProvider: "moonshot",
      profileId: "moonshot:default",
      provider: "moonshot",
      modelPrefix: "moonshot/",
    },
    {
      authChoice: "mistral-api-key",
      tokenProvider: "mistral",
      profileId: "mistral:default",
      provider: "mistral",
      modelPrefix: "mistral/",
    },
    {
      authChoice: "kimi-code-api-key",
      tokenProvider: "kimi-code",
      profileId: "kimi:default",
      provider: "kimi",
      modelPrefix: "kimi/",
    },
    {
      authChoice: "xiaomi-api-key",
      tokenProvider: "xiaomi",
      profileId: "xiaomi:default",
      provider: "xiaomi",
      modelPrefix: "xiaomi/",
    },
    {
      authChoice: "venice-api-key",
      tokenProvider: "venice",
      profileId: "venice:default",
      provider: "venice",
      modelPrefix: "venice/",
    },
    {
      authChoice: "opencode-zen",
      tokenProvider: "opencode",
      profileId: "opencode:default",
      provider: "opencode",
      modelPrefix: "opencode/",
      extraProfiles: ["opencode-go:default"],
    },
    {
      authChoice: "opencode-go",
      tokenProvider: "opencode-go",
      profileId: "opencode-go:default",
      provider: "opencode-go",
      modelPrefix: "opencode-go/",
      extraProfiles: ["opencode:default"],
    },
    {
      authChoice: "together-api-key",
      tokenProvider: "together",
      profileId: "together:default",
      provider: "together",
      modelPrefix: "together/",
    },
    {
      authChoice: "qianfan-api-key",
      tokenProvider: "qianfan",
      profileId: "qianfan:default",
      provider: "qianfan",
      modelPrefix: "qianfan/",
    },
    {
      authChoice: "synthetic-api-key",
      tokenProvider: "synthetic",
      profileId: "synthetic:default",
      provider: "synthetic",
      modelPrefix: "synthetic/",
    },
  ] as const)(
    "uses opts token for $authChoice without prompting",
    async ({ authChoice, tokenProvider, profileId, provider, modelPrefix, extraProfiles }) => {
      await setupTempState();

      const text = vi.fn();
      const confirm = vi.fn(async () => false);
      const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });
      const token = `sk-${tokenProvider}-test`;

      const result = await applyAuthChoice({
        authChoice,
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
        opts: {
          tokenProvider,
          token,
        },
      });

      expect(text).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(result.config.auth?.profiles?.[profileId]).toMatchObject({
        provider,
        mode: "api_key",
      });
      expect(
        resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)?.startsWith(
          modelPrefix,
        ),
      ).toBe(true);
      expect((await readAuthProfile(profileId))?.key).toBe(token);
      for (const extraProfile of extraProfiles ?? []) {
        expect((await readAuthProfile(extraProfile))?.key).toBe(token);
      }
    },
  );

  it("uses opts token for Gemini and keeps global default model when setDefaultModel=false", async () => {
    await setupTempState();

    const text = vi.fn();
    const confirm = vi.fn(async () => false);
    const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

    const result = await applyAuthChoice({
      authChoice: "gemini-api-key",
      config: { agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } } },
      prompter,
      runtime,
      setDefaultModel: false,
      opts: {
        tokenProvider: "google",
        token: "sk-gemini-test",
      },
    });

    expect(text).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(result.config.auth?.profiles?.["google:default"]).toMatchObject({
      provider: "google",
      mode: "api_key",
    });
    expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
      "openai/gpt-4o-mini",
    );
    expect(result.agentModelOverride).toBe(GOOGLE_GEMINI_DEFAULT_MODEL);
    expect((await readAuthProfile("google:default"))?.key).toBe("sk-gemini-test");
  });

  it("prompts for Venice API key and shows the Venice note when no token is provided", async () => {
    await setupTempState();
    process.env.VENICE_API_KEY = "";

    const note = vi.fn(async () => {});
    const text = vi.fn(async () => "sk-venice-manual");
    const prompter = createPrompter({ note, text });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "venice-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("privacy-focused inference"),
      "Venice AI",
    );
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Enter Venice AI API key",
      }),
    );
    expect(result.config.auth?.profiles?.["venice:default"]).toMatchObject({
      provider: "venice",
      mode: "api_key",
    });
    expect((await readAuthProfile("venice:default"))?.key).toBe("sk-venice-manual");
  });

  it("uses existing env API keys for selected providers", async () => {
    const scenarios: Array<{
      authChoice: "synthetic-api-key" | "openrouter-api-key" | "ai-gateway-api-key";
      envKey: "SYNTHETIC_API_KEY" | "OPENROUTER_API_KEY" | "AI_GATEWAY_API_KEY";
      envValue: string;
      profileId: string;
      provider: string;
      opts?: { secretInputMode?: "ref" };
      expectEnvPrompt: boolean;
      expectedTextCalls: number;
      expectedKey?: string;
      expectedKeyRef?: { source: "env"; provider: string; id: string };
      expectedModel?: string;
      expectedModelPrefix?: string;
    }> = [
      {
        authChoice: "synthetic-api-key",
        envKey: "SYNTHETIC_API_KEY",
        envValue: "sk-synthetic-env",
        profileId: "synthetic:default",
        provider: "synthetic",
        expectEnvPrompt: true,
        expectedTextCalls: 0,
        expectedKey: "sk-synthetic-env",
        expectedModelPrefix: "synthetic/",
      },
      {
        authChoice: "openrouter-api-key",
        envKey: "OPENROUTER_API_KEY",
        envValue: "sk-openrouter-test",
        profileId: "openrouter:default",
        provider: "openrouter",
        expectEnvPrompt: true,
        expectedTextCalls: 0,
        expectedKey: "sk-openrouter-test",
        expectedModel: "openrouter/auto",
      },
      {
        authChoice: "ai-gateway-api-key",
        envKey: "AI_GATEWAY_API_KEY",
        envValue: "gateway-test-key",
        profileId: "vercel-ai-gateway:default",
        provider: "vercel-ai-gateway",
        expectEnvPrompt: true,
        expectedTextCalls: 0,
        expectedKey: "gateway-test-key",
        expectedModel: "vercel-ai-gateway/anthropic/claude-opus-4.6",
      },
      {
        authChoice: "ai-gateway-api-key",
        envKey: "AI_GATEWAY_API_KEY",
        envValue: "gateway-ref-key",
        profileId: "vercel-ai-gateway:default",
        provider: "vercel-ai-gateway",
        opts: { secretInputMode: "ref" }, // pragma: allowlist secret
        expectEnvPrompt: false,
        expectedTextCalls: 1,
        expectedKeyRef: { source: "env", provider: "default", id: "AI_GATEWAY_API_KEY" },
        expectedModel: "vercel-ai-gateway/anthropic/claude-opus-4.6",
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();
      delete process.env.SYNTHETIC_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.AI_GATEWAY_API_KEY;
      process.env[scenario.envKey] = scenario.envValue;

      const text = vi.fn();
      const confirm = vi.fn(async () => true);
      const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
        opts: scenario.opts,
      });

      if (scenario.expectEnvPrompt) {
        expect(confirm).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining(scenario.envKey),
          }),
        );
      } else {
        expect(confirm).not.toHaveBeenCalled();
      }
      expect(text).toHaveBeenCalledTimes(scenario.expectedTextCalls);
      expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
        provider: scenario.provider,
        mode: "api_key",
      });
      if (scenario.expectedModel) {
        expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
          scenario.expectedModel,
        );
      }
      if (scenario.expectedModelPrefix) {
        expect(
          resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)?.startsWith(
            scenario.expectedModelPrefix,
          ),
        ).toBe(true);
      }
      const profile = await readAuthProfile(scenario.profileId);
      if (scenario.expectedKeyRef) {
        expect(profile?.keyRef).toEqual(scenario.expectedKeyRef);
        expect(profile?.key).toBeUndefined();
      } else {
        expect(profile?.key).toBe(scenario.expectedKey);
        expect(profile?.keyRef).toBeUndefined();
      }
    }
  });

  it("retries ref setup when provider preflight fails and can switch to env ref", async () => {
    await setupTempState();
    process.env.OPENAI_API_KEY = "sk-openai-env"; // pragma: allowlist secret

    const selectValues: Array<"provider" | "env" | "filemain"> = ["provider", "filemain", "env"];
    const select = vi.fn(async (params: Parameters<WizardPrompter["select"]>[0]) => {
      const next = selectValues[0];
      if (next && params.options.some((option) => option.value === next)) {
        selectValues.shift();
        return next as never;
      }
      return (params.options[0]?.value ?? "env") as never;
    });
    const text = vi
      .fn<WizardPrompter["text"]>()
      .mockResolvedValueOnce("/providers/openai/apiKey")
      .mockResolvedValueOnce("OPENAI_API_KEY");
    const note = vi.fn(async () => undefined);

    const prompter = createPrompter({
      select,
      text,
      note,
      confirm: vi.fn(async () => true),
    });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "openai-api-key",
      config: {
        secrets: {
          providers: {
            filemain: {
              source: "file",
              path: "/tmp/openclaw-missing-secrets.json",
              mode: "json",
            },
          },
        },
      },
      prompter,
      runtime,
      setDefaultModel: false,
      opts: { secretInputMode: "ref" }, // pragma: allowlist secret
    });

    expect(result.config.auth?.profiles?.["openai:default"]).toMatchObject({
      provider: "openai",
      mode: "api_key",
    });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Could not validate provider reference"),
      "Reference check failed",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Validated environment variable OPENAI_API_KEY."),
      "Reference validated",
    );
    expect(await readAuthProfile("openai:default")).toMatchObject({
      keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    });
  });

  it("uses explicit env for plugin auth resolution instead of host env", async () => {
    await setupTempState();
    process.env.OPENAI_API_KEY = "sk-openai-host"; // pragma: allowlist secret
    const env = { OPENAI_API_KEY: "sk-openai-explicit" } as NodeJS.ProcessEnv; // pragma: allowlist secret
    const text = vi.fn().mockResolvedValue("should-not-be-used");
    const confirm = vi.fn(async () => true);
    const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

    const result = await applyAuthChoice({
      authChoice: "openai-api-key",
      config: {},
      env,
      prompter,
      runtime,
      setDefaultModel: false,
    });

    expect(resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        env,
      }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("OPENAI_API_KEY"),
      }),
    );
    expect(text).not.toHaveBeenCalled();
    expect(result.config.auth?.profiles?.["openai:default"]).toMatchObject({
      provider: "openai",
      mode: "api_key",
    });
    expect((await readAuthProfile("openai:default"))?.key).toBe("sk-openai-explicit");
  });

  it("keeps existing default model for explicit provider keys when setDefaultModel=false", async () => {
    const scenarios: Array<{
      authChoice: "synthetic-api-key" | "opencode-zen" | "opencode-go";
      token: string;
      promptMessage: string;
      existingPrimary: string;
      expectedOverride: string;
      profileId?: string;
      profileProvider?: string;
      extraProfileId?: string;
      expectProviderConfigUndefined?: "opencode" | "opencode-go" | "opencode-zen";
      agentId?: string;
    }> = [
      {
        authChoice: "synthetic-api-key",
        token: "sk-synthetic-agent-test",
        promptMessage: "Enter Synthetic API key",
        existingPrimary: "openai/gpt-4o-mini",
        expectedOverride: "synthetic/Synthetic-1",
        profileId: "synthetic:default",
        profileProvider: "synthetic",
        agentId: "agent-1",
      },
      {
        authChoice: "opencode-zen",
        token: "sk-opencode-zen-test",
        promptMessage: "Enter OpenCode API key",
        existingPrimary: "anthropic/claude-opus-4-5",
        expectedOverride: "opencode/claude-opus-4-6",
        profileId: "opencode:default",
        profileProvider: "opencode",
        extraProfileId: "opencode-go:default",
        expectProviderConfigUndefined: "opencode",
      },
      {
        authChoice: "opencode-go",
        token: "sk-opencode-go-test",
        promptMessage: "Enter OpenCode API key",
        existingPrimary: "anthropic/claude-opus-4-5",
        expectedOverride: "opencode-go/kimi-k2.5",
        profileId: "opencode-go:default",
        profileProvider: "opencode-go",
        extraProfileId: "opencode:default",
        expectProviderConfigUndefined: "opencode-go",
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();

      const text = vi.fn().mockResolvedValue(scenario.token);
      const { prompter, runtime } = createApiKeyPromptHarness({ text });

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: { agents: { defaults: { model: { primary: scenario.existingPrimary } } } },
        prompter,
        runtime,
        setDefaultModel: false,
        agentId: scenario.agentId,
      });

      expect(text).toHaveBeenCalledWith(
        expect.objectContaining({ message: scenario.promptMessage }),
      );
      expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
        scenario.existingPrimary,
      );
      expect(result.agentModelOverride).toBe(scenario.expectedOverride);
      if (scenario.profileId && scenario.profileProvider) {
        expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
          provider: scenario.profileProvider,
          mode: "api_key",
        });
        const profileStore =
          scenario.agentId && scenario.agentId !== "default"
            ? await readAuthProfilesForAgent<{ profiles?: Record<string, StoredAuthProfile> }>(
                resolveAgentDir(result.config, scenario.agentId),
              )
            : await readAuthProfiles();
        expect(profileStore.profiles?.[scenario.profileId]?.key).toBe(scenario.token);
      }
      if (scenario.extraProfileId) {
        const profileStore =
          scenario.agentId && scenario.agentId !== "default"
            ? await readAuthProfilesForAgent<{ profiles?: Record<string, StoredAuthProfile> }>(
                resolveAgentDir(result.config, scenario.agentId),
              )
            : await readAuthProfiles();
        expect(profileStore.profiles?.[scenario.extraProfileId]?.key).toBe(scenario.token);
      }
      if (scenario.expectProviderConfigUndefined) {
        expect(
          result.config.models?.providers?.[scenario.expectProviderConfigUndefined],
        ).toBeUndefined();
      }
    }
  });

  it("sets default model when selecting github-copilot", async () => {
    await setupTempState();

    resolvePluginProviders.mockReturnValue([
      {
        id: "github-copilot",
        label: "GitHub Copilot",
        auth: [
          {
            id: "device",
            label: "GitHub device login",
            kind: "device_code",
            run: vi.fn(async () => ({
              profiles: [
                {
                  profileId: "github-copilot:github",
                  credential: {
                    type: "token",
                    provider: "github-copilot",
                    token: "github-device-token",
                  },
                },
              ],
              defaultModel: "github-copilot/gpt-4o",
            })),
          },
        ],
      },
    ] as never);

    const prompter = createPrompter({});
    const runtime = createExitThrowingRuntime();

    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const hadOwnIsTTY = Object.prototype.hasOwnProperty.call(stdin, "isTTY");
    const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
    Object.defineProperty(stdin, "isTTY", {
      configurable: true,
      enumerable: true,
      get: () => true,
    });

    try {
      const result = await applyAuthChoice({
        authChoice: "github-copilot",
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
      });

      expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
        "github-copilot/gpt-4o",
      );
    } finally {
      if (previousIsTTYDescriptor) {
        Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
      } else if (!hadOwnIsTTY) {
        delete (stdin as { isTTY?: boolean }).isTTY;
      }
    }
  });

  it("does not persist literal 'undefined' when API key prompts return undefined", async () => {
    const scenarios = [
      {
        authChoice: "synthetic-api-key" as const,
        envKey: "SYNTHETIC_API_KEY",
        profileId: "synthetic:default",
        provider: "synthetic",
      },
    ];

    for (const scenario of scenarios) {
      await setupTempState();
      delete process.env[scenario.envKey];

      const text = vi.fn(async () => undefined as unknown as string);
      const prompter = createPrompter({ text });
      const runtime = createExitThrowingRuntime();

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: {},
        prompter,
        runtime,
        setDefaultModel: false,
      });

      expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
        provider: scenario.provider,
        mode: "api_key",
      });

      const profile = await readAuthProfile(scenario.profileId);
      expect(profile?.key).toBe("");
      expect(profile?.key).not.toBe("undefined");
    }
  });

  it("ignores legacy LiteLLM oauth profiles when selecting litellm-api-key", async () => {
    await setupTempState();
    process.env.LITELLM_API_KEY = "sk-litellm-test"; // pragma: allowlist secret

    const authProfilePath = authProfilePathForAgent(requireOpenClawAgentDir());
    await fs.writeFile(
      authProfilePath,
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "litellm:legacy": {
              type: "oauth",
              provider: "litellm",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const text = vi.fn();
    const confirm = vi.fn(async () => true);
    const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

    const result = await applyAuthChoice({
      authChoice: "litellm-api-key",
      config: {
        auth: {
          profiles: {
            "litellm:legacy": { provider: "litellm", mode: "oauth" },
          },
          order: { litellm: ["litellm:legacy"] },
        },
      },
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("LITELLM_API_KEY"),
      }),
    );
    expect(text).not.toHaveBeenCalled();
    expect(result.config.auth?.profiles?.["litellm:default"]).toMatchObject({
      provider: "litellm",
      mode: "api_key",
    });

    expect(await readAuthProfile("litellm:default")).toMatchObject({
      type: "api_key",
      key: "sk-litellm-test",
    });
  });

  it("configures cloudflare ai gateway via env key and explicit opts", async () => {
    const scenarios: Array<{
      envGatewayKey?: string;
      textValues: string[];
      confirmValue: boolean;
      opts?: {
        secretInputMode?: "ref"; // pragma: allowlist secret
        cloudflareAiGatewayAccountId?: string;
        cloudflareAiGatewayGatewayId?: string;
        cloudflareAiGatewayApiKey?: string;
      };
      expectEnvPrompt: boolean;
      expectedTextCalls: number;
      expectedKey?: string;
      expectedKeyRef?: { source: string; provider: string; id: string };
      expectedMetadata: { accountId: string; gatewayId: string };
    }> = [
      {
        envGatewayKey: "cf-gateway-test-key",
        textValues: ["cf-account-id", "cf-gateway-id"],
        confirmValue: true,
        expectEnvPrompt: true,
        expectedTextCalls: 2,
        expectedKey: "cf-gateway-test-key",
        expectedMetadata: {
          accountId: "cf-account-id",
          gatewayId: "cf-gateway-id",
        },
      },
      {
        envGatewayKey: "cf-gateway-ref-key",
        textValues: ["cf-account-id-ref", "cf-gateway-id-ref"],
        confirmValue: true,
        opts: {
          secretInputMode: "ref", // pragma: allowlist secret
        },
        expectEnvPrompt: false,
        expectedTextCalls: 3,
        expectedKeyRef: { source: "env", provider: "default", id: "CLOUDFLARE_AI_GATEWAY_API_KEY" },
        expectedMetadata: {
          accountId: "cf-account-id-ref",
          gatewayId: "cf-gateway-id-ref",
        },
      },
      {
        textValues: [],
        confirmValue: false,
        opts: {
          cloudflareAiGatewayAccountId: "acc-direct",
          cloudflareAiGatewayGatewayId: "gw-direct",
          cloudflareAiGatewayApiKey: "cf-direct-key", // pragma: allowlist secret
        },
        expectEnvPrompt: false,
        expectedTextCalls: 0,
        expectedKey: "cf-direct-key",
        expectedMetadata: {
          accountId: "acc-direct",
          gatewayId: "gw-direct",
        },
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();
      delete process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
      if (scenario.envGatewayKey) {
        process.env.CLOUDFLARE_AI_GATEWAY_API_KEY = scenario.envGatewayKey;
      }

      const text = vi.fn();
      for (const textValue of scenario.textValues) {
        text.mockResolvedValueOnce(textValue);
      }
      const confirm = vi.fn(async () => scenario.confirmValue);
      const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

      const result = await applyAuthChoice({
        authChoice: "cloudflare-ai-gateway-api-key",
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
        opts: scenario.opts,
      });

      if (scenario.expectEnvPrompt) {
        expect(confirm).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining("CLOUDFLARE_AI_GATEWAY_API_KEY"),
          }),
        );
      } else {
        expect(confirm).not.toHaveBeenCalled();
      }
      expect(text).toHaveBeenCalledTimes(scenario.expectedTextCalls);
      expect(result.config.auth?.profiles?.["cloudflare-ai-gateway:default"]).toMatchObject({
        provider: "cloudflare-ai-gateway",
        mode: "api_key",
      });
      expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
        "cloudflare-ai-gateway/claude-sonnet-4-5",
      );

      const profile = await readAuthProfile("cloudflare-ai-gateway:default");
      if (scenario.expectedKeyRef) {
        expect(profile?.keyRef).toEqual(scenario.expectedKeyRef);
      } else {
        expect(profile?.key).toBe(scenario.expectedKey);
      }
      expect(profile?.metadata).toEqual(scenario.expectedMetadata);
    }
    delete process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
  });

  it("writes Chutes OAuth credentials when selecting chutes (remote/manual)", async () => {
    await setupTempState();
    process.env.SSH_TTY = "1";
    process.env.CHUTES_CLIENT_ID = "cid_test";

    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://api.chutes.ai/idp/token") {
        return new Response(
          JSON.stringify({
            access_token: "at_test",
            refresh_token: "rt_test",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://api.chutes.ai/idp/userinfo") {
        return new Response(JSON.stringify({ username: "remote-user" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const runtime = createExitThrowingRuntime();
    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message.startsWith("Paste the redirect URL")) {
        const runtimeLog = runtime.log as ReturnType<typeof vi.fn>;
        const lastLog = runtimeLog.mock.calls.at(-1)?.[0];
        const urlLine = typeof lastLog === "string" ? lastLog : String(lastLog ?? "");
        const urlMatch = urlLine.match(/https?:\/\/\S+/)?.[0] ?? "";
        const state = urlMatch ? new URL(urlMatch).searchParams.get("state") : null;
        if (!state) {
          throw new Error("missing state in oauth URL");
        }
        return `?code=code_manual&state=${state}`;
      }
      return "code_manual";
    });
    const { prompter } = createApiKeyPromptHarness({ text });

    const result = await applyAuthChoice({
      authChoice: "chutes",
      config: {},
      prompter,
      runtime,
      setDefaultModel: false,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Paste the redirect URL"),
      }),
    );
    expect(result.config.auth?.profiles?.["chutes:remote-user"]).toMatchObject({
      provider: "chutes",
      mode: "oauth",
    });

    expect(await readAuthProfile("chutes:remote-user")).toMatchObject({
      provider: "chutes",
      access: "at_test",
      refresh: "rt_test",
      email: "remote-user",
    });
  });

  it("writes portal OAuth credentials for plugin providers", async () => {
    const scenarios: Array<{
      authChoice: "minimax-global-oauth";
      label: string;
      authId: string;
      authLabel: string;
      providerId: string;
      profileId: string;
      baseUrl: string;
      api: "openai-completions" | "anthropic-messages";
      defaultModel: string;
      apiKey: string;
      selectValue?: string;
    }> = [
      {
        authChoice: "minimax-global-oauth",
        label: "MiniMax",
        authId: "oauth",
        authLabel: "MiniMax OAuth (Global)",
        providerId: "minimax-portal",
        profileId: "minimax-portal:default",
        baseUrl: "https://api.minimax.io/anthropic",
        api: "anthropic-messages",
        defaultModel: "minimax-portal/MiniMax-M2.7",
        apiKey: "minimax-oauth", // pragma: allowlist secret
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();

      resolvePluginProviders.mockReturnValue([
        {
          id: scenario.providerId,
          label: scenario.label,
          auth: [
            {
              id: scenario.authId,
              label: scenario.authLabel,
              kind: "device_code",
              wizard: { choiceId: scenario.authChoice },
              run: vi.fn(async () => ({
                profiles: [
                  {
                    profileId: scenario.profileId,
                    credential: {
                      type: "oauth",
                      provider: scenario.providerId,
                      access: "access",
                      refresh: "refresh",
                      expires: Date.now() + 60 * 60 * 1000,
                    },
                  },
                ],
                configPatch: {
                  models: {
                    providers: {
                      [scenario.providerId]: {
                        baseUrl: scenario.baseUrl,
                        apiKey: scenario.apiKey,
                        api: scenario.api,
                        models: [],
                      },
                    },
                  },
                },
                defaultModel: scenario.defaultModel,
              })),
            },
          ],
        },
      ] as never);

      const prompter = createPrompter(
        scenario.selectValue
          ? { select: vi.fn(async () => scenario.selectValue as never) as WizardPrompter["select"] }
          : {},
      );
      const runtime = createExitThrowingRuntime();

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
      });

      expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
        provider: scenario.providerId,
        mode: "oauth",
      });
      expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
        scenario.defaultModel,
      );
      expect(result.config.models?.providers?.[scenario.providerId]).toMatchObject({
        baseUrl: scenario.baseUrl,
        apiKey: scenario.apiKey,
      });
      expect(await readAuthProfile(scenario.profileId)).toMatchObject({
        provider: scenario.providerId,
        access: "access",
        refresh: "refresh",
      });
    }
  });
});

describe("resolvePreferredProviderForAuthChoice", () => {
  it("maps known and unknown auth choices", async () => {
    const scenarios = [
      { authChoice: "github-copilot" as const, expectedProvider: "github-copilot" },
      { authChoice: "mistral-api-key" as const, expectedProvider: "mistral" },
      { authChoice: "ollama" as const, expectedProvider: "ollama" },
      { authChoice: "unknown" as AuthChoice, expectedProvider: undefined },
    ] as const;
    for (const scenario of scenarios) {
      await expect(
        resolvePreferredProviderForAuthChoice({ choice: scenario.authChoice }),
      ).resolves.toBe(scenario.expectedProvider);
    }
  });
});
