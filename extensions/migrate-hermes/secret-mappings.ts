// Hermes environment credential catalog.

export type SecretCredentialMode = "api_key" | "token";

export type SecretMapping = {
  envVar: string;
  provider: string;
  profileId: string;
  mode?: SecretCredentialMode;
};

export const SECRET_MAPPINGS: readonly SecretMapping[] = [
  { envVar: "OPENAI_API_KEY", provider: "openai", profileId: "openai:hermes-import" },
  { envVar: "ANTHROPIC_API_KEY", provider: "anthropic", profileId: "anthropic:hermes-import" },
  { envVar: "OPENROUTER_API_KEY", provider: "openrouter", profileId: "openrouter:hermes-import" },
  { envVar: "GOOGLE_API_KEY", provider: "google", profileId: "google:hermes-import" },
  { envVar: "GEMINI_API_KEY", provider: "google", profileId: "google:hermes-import" },
  { envVar: "GROQ_API_KEY", provider: "groq", profileId: "groq:hermes-import" },
  { envVar: "XAI_API_KEY", provider: "xai", profileId: "xai:hermes-import" },
  { envVar: "MISTRAL_API_KEY", provider: "mistral", profileId: "mistral:hermes-import" },
  { envVar: "DEEPSEEK_API_KEY", provider: "deepseek", profileId: "deepseek:hermes-import" },
  { envVar: "ZAI_API_KEY", provider: "zai", profileId: "zai:hermes-import" },
  { envVar: "Z_AI_API_KEY", provider: "zai", profileId: "zai:hermes-import" },
  { envVar: "GLM_API_KEY", provider: "zai", profileId: "zai:hermes-import" },
  { envVar: "KIMI_API_KEY", provider: "kimi", profileId: "kimi:hermes-import" },
  { envVar: "KIMICODE_API_KEY", provider: "kimi", profileId: "kimi:hermes-import" },
  {
    envVar: "KIMI_CODING_API_KEY",
    provider: "kimi",
    profileId: "kimi:hermes-import",
  },
  { envVar: "MOONSHOT_API_KEY", provider: "moonshot", profileId: "moonshot:hermes-import" },
  { envVar: "KIMI_CN_API_KEY", provider: "moonshot", profileId: "moonshot:hermes-import" },
  { envVar: "MINIMAX_API_KEY", provider: "minimax", profileId: "minimax:hermes-import" },
  { envVar: "MINIMAX_CN_API_KEY", provider: "minimax", profileId: "minimax:hermes-import" },
  {
    envVar: "MINIMAX_CODING_API_KEY",
    provider: "minimax",
    profileId: "minimax:hermes-import",
  },
  { envVar: "DASHSCOPE_API_KEY", provider: "qwen", profileId: "qwen:hermes-import" },
  { envVar: "QWEN_API_KEY", provider: "qwen", profileId: "qwen:hermes-import" },
  { envVar: "MODELSTUDIO_API_KEY", provider: "qwen", profileId: "qwen:hermes-import" },
  { envVar: "KILOCODE_API_KEY", provider: "kilocode", profileId: "kilocode:hermes-import" },
  {
    envVar: "AI_GATEWAY_API_KEY",
    provider: "vercel-ai-gateway",
    profileId: "vercel-ai-gateway:hermes-import",
  },
  { envVar: "HF_TOKEN", provider: "huggingface", profileId: "huggingface:hermes-import" },
  {
    envVar: "HUGGINGFACE_HUB_TOKEN",
    provider: "huggingface",
    profileId: "huggingface:hermes-import",
  },
  { envVar: "TOGETHER_API_KEY", provider: "together", profileId: "together:hermes-import" },
  { envVar: "FIREWORKS_API_KEY", provider: "fireworks", profileId: "fireworks:hermes-import" },
  { envVar: "DEEPINFRA_API_KEY", provider: "deepinfra", profileId: "deepinfra:hermes-import" },
  { envVar: "CEREBRAS_API_KEY", provider: "cerebras", profileId: "cerebras:hermes-import" },
  { envVar: "NVIDIA_API_KEY", provider: "nvidia", profileId: "nvidia:hermes-import" },
  { envVar: "VENICE_API_KEY", provider: "venice", profileId: "venice:hermes-import" },
  { envVar: "XIAOMI_API_KEY", provider: "xiaomi", profileId: "xiaomi:hermes-import" },
  { envVar: "ALIBABA_API_KEY", provider: "qwen", profileId: "qwen:hermes-import" },
  {
    envVar: "ALIBABA_CODING_PLAN_API_KEY",
    provider: "qwen",
    profileId: "qwen:hermes-import",
  },
  { envVar: "ARCEEAI_API_KEY", provider: "arcee", profileId: "arcee:hermes-import" },
  { envVar: "CHUTES_API_KEY", provider: "chutes", profileId: "chutes:hermes-import" },
  {
    envVar: "CLOUDFLARE_AI_GATEWAY_API_KEY",
    provider: "cloudflare-ai-gateway",
    profileId: "cloudflare-ai-gateway:hermes-import",
  },
  { envVar: "QIANFAN_API_KEY", provider: "qianfan", profileId: "qianfan:hermes-import" },
  { envVar: "OPENCODE_API_KEY", provider: "opencode", profileId: "opencode:hermes-import" },
  { envVar: "OPENCODE_API_KEY", provider: "opencode-go", profileId: "opencode-go:hermes-import" },
  { envVar: "OPENCODE_ZEN_API_KEY", provider: "opencode", profileId: "opencode:hermes-import" },
  {
    envVar: "OPENCODE_ZEN_API_KEY",
    provider: "opencode-go",
    profileId: "opencode-go:hermes-import",
  },
  {
    envVar: "OPENCODE_GO_API_KEY",
    provider: "opencode-go",
    profileId: "opencode-go:hermes-import",
  },
  {
    envVar: "COPILOT_GITHUB_TOKEN",
    provider: "github-copilot",
    profileId: "github-copilot:github",
    mode: "token",
  },
  {
    envVar: "GH_TOKEN",
    provider: "github-copilot",
    profileId: "github-copilot:github",
    mode: "token",
  },
  {
    envVar: "GITHUB_TOKEN",
    provider: "github-copilot",
    profileId: "github-copilot:github",
    mode: "token",
  },
] as const;
