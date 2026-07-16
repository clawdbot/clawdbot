export type CapabilityTransport = "local" | "gateway";

type CapabilityMetadata = {
  id: string;
  description: string;
  transports: Array<CapabilityTransport>;
  flags: string[];
  resultShape: string;
};

export type CapabilityEnvelope = {
  ok: boolean;
  capability: string;
  transport: CapabilityTransport;
  provider?: string;
  model?: string;
  attempts: Array<Record<string, unknown>>;
  inputs?: Array<Record<string, unknown>>;
  outputs: Array<Record<string, unknown>>;
  ignoredOverrides?: Array<Record<string, unknown>>;
  error?: string;
};

export const CAPABILITY_METADATA: CapabilityMetadata[] = [
  {
    id: "model.run",
    description: "Run a one-shot inference turn through the selected model provider.",
    transports: ["local", "gateway"],
    flags: ["--prompt", "--file", "--model", "--thinking", "--local", "--gateway", "--json"],
    resultShape: "normalized payloads plus provider/model attribution",
  },
  {
    id: "model.list",
    description: "List known models from the model catalog.",
    transports: ["local"],
    flags: ["--json"],
    resultShape: "catalog entries",
  },
  {
    id: "model.inspect",
    description: "Inspect one model catalog entry.",
    transports: ["local"],
    flags: ["--model", "--json"],
    resultShape: "single catalog entry",
  },
  {
    id: "model.providers",
    description: "List model providers discovered from the catalog.",
    transports: ["local"],
    flags: ["--json"],
    resultShape: "provider ids with counts and defaults",
  },
  {
    id: "model.auth.login",
    description: "Run the existing provider auth login flow.",
    transports: ["local"],
    flags: ["--provider", "--method"],
    resultShape: "interactive auth result",
  },
  {
    id: "model.auth.logout",
    description: "Remove saved auth profiles for one provider.",
    transports: ["local"],
    flags: ["--provider", "--agent", "--json"],
    resultShape: "removed profile ids",
  },
  {
    id: "model.auth.status",
    description: "Show configured model auth state.",
    transports: ["local"],
    flags: ["--json"],
    resultShape: "model status summary",
  },
  {
    id: "image.generate",
    description: "Generate raster images with configured image providers.",
    transports: ["local"],
    flags: [
      "--prompt",
      "--model",
      "--count",
      "--size",
      "--aspect-ratio",
      "--resolution",
      "--output-format",
      "--background",
      "--openai-background",
      "--openai-moderation",
      "--quality",
      "--timeout-ms",
      "--output",
      "--json",
    ],
    resultShape: "saved image files plus attempts",
  },
  {
    id: "image.edit",
    description: "Generate edited images from one or more input files.",
    transports: ["local"],
    flags: [
      "--file",
      "--prompt",
      "--model",
      "--count",
      "--size",
      "--aspect-ratio",
      "--resolution",
      "--output-format",
      "--background",
      "--openai-background",
      "--openai-moderation",
      "--quality",
      "--timeout-ms",
      "--output",
      "--json",
    ],
    resultShape: "saved image files plus attempts",
  },
  {
    id: "image.describe",
    description: "Describe one image file through media-understanding providers.",
    transports: ["local"],
    flags: ["--file", "--prompt", "--model", "--timeout-ms", "--json"],
    resultShape: "normalized text output",
  },
  {
    id: "image.describe-many",
    description: "Describe multiple image files independently.",
    transports: ["local"],
    flags: ["--file", "--prompt", "--model", "--timeout-ms", "--json"],
    resultShape: "one text output per file",
  },
  {
    id: "image.providers",
    description: "List image generation providers.",
    transports: ["local"],
    flags: ["--json"],
    resultShape: "provider ids and defaults",
  },
  {
    id: "audio.transcribe",
    description: "Transcribe one audio file.",
    transports: ["local"],
    flags: ["--file", "--language", "--prompt", "--model", "--json"],
    resultShape: "normalized text output",
  },
  {
    id: "audio.providers",
    description: "List audio transcription providers.",
    transports: ["local"],
    flags: ["--json"],
    resultShape: "provider ids and capabilities",
  },
  {
    id: "tts.convert",
    description: "Convert text to speech.",
    transports: ["local", "gateway"],
    flags: [
      "--text",
      "--channel",
      "--voice",
      "--model",
      "--output",
      "--local",
      "--gateway",
      "--json",
    ],
    resultShape: "saved audio file plus attempts",
  },
  {
    id: "tts.voices",
    description: "List voices for a speech provider.",
    transports: ["local"],
    flags: ["--provider", "--json"],
    resultShape: "voice entries",
  },
  {
    id: "tts.providers",
    description: "List speech providers.",
    transports: ["local", "gateway"],
    flags: ["--local", "--gateway", "--json"],
    resultShape: "provider ids, configured state, models, voices",
  },
  {
    id: "tts.personas",
    description: "List TTS personas.",
    transports: ["local", "gateway"],
    flags: ["--local", "--gateway", "--json"],
    resultShape: "persona ids, labels, providers, active persona",
  },
  {
    id: "tts.status",
    description: "Show gateway-managed TTS state.",
    transports: ["gateway"],
    flags: ["--gateway", "--json"],
    resultShape: "enabled/provider state",
  },
  {
    id: "tts.enable",
    description: "Enable TTS in prefs.",
    transports: ["local", "gateway"],
    flags: ["--local", "--gateway", "--json"],
    resultShape: "enabled state",
  },
  {
    id: "tts.disable",
    description: "Disable TTS in prefs.",
    transports: ["local", "gateway"],
    flags: ["--local", "--gateway", "--json"],
    resultShape: "enabled state",
  },
  {
    id: "tts.set-provider",
    description: "Set the active TTS provider.",
    transports: ["local", "gateway"],
    flags: ["--provider", "--local", "--gateway", "--json"],
    resultShape: "selected provider",
  },
  {
    id: "tts.set-persona",
    description: "Set the active TTS persona.",
    transports: ["local", "gateway"],
    flags: ["--persona", "--off", "--local", "--gateway", "--json"],
    resultShape: "selected persona",
  },
  {
    id: "video.generate",
    description: "Generate video files with configured video providers.",
    transports: ["local"],
    flags: [
      "--prompt",
      "--model",
      "--size",
      "--aspect-ratio",
      "--resolution",
      "--duration",
      "--audio",
      "--watermark",
      "--timeout-ms",
      "--output",
      "--json",
    ],
    resultShape: "saved video files plus attempts",
  },
  {
    id: "video.describe",
    description: "Describe one video file through media-understanding providers.",
    transports: ["local"],
    flags: ["--file", "--model", "--json"],
    resultShape: "normalized text output",
  },
  {
    id: "video.providers",
    description: "List video generation and description providers.",
    transports: ["local"],
    flags: ["--json"],
    resultShape: "provider ids and defaults",
  },
  {
    id: "web.search",
    description: "Run provider-backed web search.",
    transports: ["local"],
    flags: ["--query", "--provider", "--limit", "--json"],
    resultShape: "search provider result",
  },
  {
    id: "web.fetch",
    description: "Fetch URL content through configured web fetch providers.",
    transports: ["local"],
    flags: ["--url", "--provider", "--format", "--json"],
    resultShape: "fetch provider result",
  },
  {
    id: "web.providers",
    description: "List web search and fetch providers.",
    transports: ["local"],
    flags: ["--json"],
    resultShape: "provider ids grouped by family",
  },
  {
    id: "embedding.create",
    description: "Create embeddings through embedding providers.",
    transports: ["local"],
    flags: ["--text", "--provider", "--model", "--json"],
    resultShape: "vectors with provider/model attribution",
  },
  {
    id: "embedding.providers",
    description: "List embedding providers.",
    transports: ["local"],
    flags: ["--json"],
    resultShape: "provider ids and default models",
  },
];

export function findCapabilityMetadata(id: string): CapabilityMetadata | undefined {
  return CAPABILITY_METADATA.find((entry) => entry.id === id);
}
