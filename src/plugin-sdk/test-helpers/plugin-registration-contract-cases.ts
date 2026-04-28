import { describePluginRegistrationContract } from "./plugin-registration-contract.js";

type PluginRegistrationContractParams = Parameters<typeof describePluginRegistrationContract>[0];

export const pluginRegistrationContractCases = {
  anthropic: {
    pluginId: "anthropic",
    providerIds: ["anthropic"],
    mediaUnderstandingProviderIds: ["anthropic"],
    cliBackendIds: ["claude-cli"],
    requireDescribeImages: true,
  },
  brave: {
    pluginId: "brave",
    webSearchProviderIds: ["brave"],
  },
  comfy: {
    pluginId: "comfy",
    providerIds: ["comfy"],
    imageGenerationProviderIds: ["comfy"],
    musicGenerationProviderIds: ["comfy"],
    videoGenerationProviderIds: ["comfy"],
    requireGenerateImage: true,
    requireGenerateVideo: true,
  },
  deepgram: {
    pluginId: "deepgram",
    mediaUnderstandingProviderIds: ["deepgram"],
  },
  duckduckgo: {
    pluginId: "duckduckgo",
    webSearchProviderIds: ["duckduckgo"],
  },
  elevenlabs: {
    pluginId: "elevenlabs",
    speechProviderIds: ["elevenlabs"],
    requireSpeechVoices: true,
  },
  exa: {
    pluginId: "exa",
    webSearchProviderIds: ["exa"],
  },
  fal: {
    pluginId: "fal",
    providerIds: ["fal"],
    imageGenerationProviderIds: ["fal"],
  },
  firecrawl: {
    pluginId: "firecrawl",
    webFetchProviderIds: ["firecrawl"],
    webSearchProviderIds: ["firecrawl"],
    toolNames: ["firecrawl_search", "firecrawl_scrape"],
  },
  google: {
    pluginId: "google",
    providerIds: ["google", "google-gemini-cli", "google-vertex"],
    webSearchProviderIds: ["gemini"],
    realtimeVoiceProviderIds: ["google"],
    speechProviderIds: ["google"],
    mediaUnderstandingProviderIds: ["google"],
    imageGenerationProviderIds: ["google"],
    requireDescribeImages: true,
    requireGenerateImage: true,
  },
  groq: {
    pluginId: "groq",
    mediaUnderstandingProviderIds: ["groq"],
  },
  microsoft: {
    pluginId: "microsoft",
    speechProviderIds: ["microsoft"],
    requireSpeechVoices: true,
  },
  minimax: {
    pluginId: "minimax",
    providerIds: ["minimax", "minimax-portal"],
    mediaUnderstandingProviderIds: ["minimax", "minimax-portal"],
    imageGenerationProviderIds: ["minimax", "minimax-portal"],
    requireDescribeImages: true,
    requireGenerateImage: true,
  },
  mistral: {
    pluginId: "mistral",
    mediaUnderstandingProviderIds: ["mistral"],
  },
  moonshot: {
    pluginId: "moonshot",
    providerIds: ["moonshot"],
    webSearchProviderIds: ["kimi"],
    mediaUnderstandingProviderIds: ["moonshot"],
    requireDescribeImages: true,
    manifestAuthChoice: {
      pluginId: "kimi",
      choiceId: "kimi-code-api-key",
      choiceLabel: "Kimi Code API key (subscription)",
      groupId: "moonshot",
      groupLabel: "Moonshot AI (Kimi K2.6)",
      groupHint: "Kimi K2.6",
    },
  },
  openai: {
    pluginId: "openai",
    providerIds: ["openai", "openai-codex"],
    speechProviderIds: ["openai"],
    realtimeTranscriptionProviderIds: ["openai"],
    realtimeVoiceProviderIds: ["openai"],
    mediaUnderstandingProviderIds: ["openai", "openai-codex"],
    imageGenerationProviderIds: ["openai"],
    requireSpeechVoices: true,
    requireDescribeImages: true,
    requireGenerateImage: true,
  },
  openrouter: {
    pluginId: "openrouter",
    providerIds: ["openrouter"],
    mediaUnderstandingProviderIds: ["openrouter"],
    imageGenerationProviderIds: ["openrouter"],
    requireDescribeImages: true,
    requireGenerateImage: true,
  },
  perplexity: {
    pluginId: "perplexity",
    webSearchProviderIds: ["perplexity"],
  },
  senseaudio: {
    pluginId: "senseaudio",
    mediaUnderstandingProviderIds: ["senseaudio"],
  },
  tavily: {
    pluginId: "tavily",
    webSearchProviderIds: ["tavily"],
    toolNames: ["tavily_search", "tavily_extract"],
  },
  "tts-local-cli": {
    pluginId: "tts-local-cli",
    speechProviderIds: ["tts-local-cli", "cli"],
  },
  xai: {
    pluginId: "xai",
    providerIds: ["xai"],
    webSearchProviderIds: ["grok"],
    realtimeTranscriptionProviderIds: ["xai"],
    mediaUnderstandingProviderIds: ["xai"],
  },
  zai: {
    pluginId: "zai",
    mediaUnderstandingProviderIds: ["zai"],
    requireDescribeImages: true,
  },
} satisfies Record<string, PluginRegistrationContractParams>;
