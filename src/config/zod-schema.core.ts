import { z } from "zod";

import { isSafeExecutableValue } from "../infra/exec-safety.js";

export const ModelApiSchema = z.union([
  z.literal("openai-completions"),
  z.literal("openai-responses"),
  z.literal("anthropic-messages"),
  z.literal("google-generative-ai"),
  z.literal("github-copilot"),
  z.literal("bedrock-converse-stream"),
]);

export const ModelCompatSchema = z
  .object({
    supportsStore: z.boolean().optional(),
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
    maxTokensField: z
      .union([z.literal("max_completion_tokens"), z.literal("max_tokens")])
      .optional(),
  })
  .strict()
  .optional();

export const ModelDefinitionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    api: ModelApiSchema.optional(),
    reasoning: z.boolean().optional(),
    input: z.array(z.union([z.literal("text"), z.literal("image")])).optional(),
    cost: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        cacheRead: z.number().optional(),
        cacheWrite: z.number().optional(),
      })
      .strict()
      .optional(),
    contextWindow: z.number().positive().optional(),
    maxTokens: z.number().positive().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    compat: ModelCompatSchema,
    confidentialCompute: z.boolean().optional(),
  })
  .strict();

export const ModelProviderSchema = z
  .object({
    baseUrl: z.string().min(1),
    apiKey: z.string().optional(),
    auth: z
      .union([z.literal("api-key"), z.literal("aws-sdk"), z.literal("oauth"), z.literal("token")])
      .optional(),
    api: ModelApiSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    authHeader: z.boolean().optional(),
    models: z.array(ModelDefinitionSchema),
    teeOnly: z.boolean().optional(),
  })
  .strict();

export const BedrockDiscoverySchema = z
  .object({
    enabled: z.boolean().optional(),
    region: z.string().optional(),
    providerFilter: z.array(z.string()).optional(),
    refreshInterval: z.number().int().nonnegative().optional(),
    defaultContextWindow: z.number().int().positive().optional(),
    defaultMaxTokens: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const ModelsConfigSchema = z
  .object({
    mode: z.union([z.literal("merge"), z.literal("replace")]).optional(),
    providers: z.record(z.string(), ModelProviderSchema).optional(),
    bedrockDiscovery: BedrockDiscoverySchema,
  })
  .strict()
  .optional();

export const GroupChatSchema = z
  .object({
    mentionPatterns: z.array(z.string()).optional(),
    historyLimit: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const DmConfigSchema = z
  .object({
    historyLimit: z.number().int().min(0).optional(),
  })
  .strict();

export const IdentitySchema = z
  .object({
    name: z.string().optional(),
    theme: z.string().optional(),
    emoji: z.string().optional(),
    avatar: z.string().optional(),
  })
  .strict()
  .optional();

export const QueueModeSchema = z.union([
  z.literal("steer"),
  z.literal("followup"),
  z.literal("collect"),
  z.literal("steer-backlog"),
  z.literal("steer+backlog"),
  z.literal("queue"),
  z.literal("interrupt"),
]);
export const QueueDropSchema = z.union([
  z.literal("old"),
  z.literal("new"),
  z.literal("summarize"),
]);
export const ReplyToModeSchema = z.union([z.literal("off"), z.literal("first"), z.literal("all")]);

// GroupPolicySchema: controls how group messages are handled
// Used with .default("allowlist").optional() pattern:
//   - .optional() allows field omission in input config
//   - .default("allowlist") ensures runtime always resolves to "allowlist" if not provided
export const GroupPolicySchema = z.enum(["open", "disabled", "allowlist"]);

export const DmPolicySchema = z.enum(["pairing", "allowlist", "open", "disabled"]);

export const BlockStreamingCoalesceSchema = z
  .object({
    minChars: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().optional(),
    idleMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export const BlockStreamingChunkSchema = z
  .object({
    minChars: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().optional(),
    breakPreference: z
      .union([z.literal("paragraph"), z.literal("newline"), z.literal("sentence")])
      .optional(),
  })
  .strict();

export const MarkdownTableModeSchema = z.enum(["off", "bullets", "code"]);

export const MarkdownConfigSchema = z
  .object({
    tables: MarkdownTableModeSchema.optional(),
  })
  .strict()
  .optional();

export const TtsProviderSchema = z.enum(["elevenlabs", "openai", "edge"]);
export const TtsModeSchema = z.enum(["final", "all"]);
export const TtsAutoSchema = z.enum(["off", "always", "inbound", "tagged"]);
export const TtsConfigSchema = z
  .object({
    auto: TtsAutoSchema.optional(),
    enabled: z.boolean().optional(),
    mode: TtsModeSchema.optional(),
    provider: TtsProviderSchema.optional(),
    summaryModel: z.string().optional(),
    modelOverrides: z
      .object({
        enabled: z.boolean().optional(),
        allowText: z.boolean().optional(),
        allowProvider: z.boolean().optional(),
        allowVoice: z.boolean().optional(),
        allowModelId: z.boolean().optional(),
        allowVoiceSettings: z.boolean().optional(),
        allowNormalization: z.boolean().optional(),
        allowSeed: z.boolean().optional(),
      })
      .strict()
      .optional(),
    elevenlabs: z
      .object({
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
        voiceId: z.string().optional(),
        modelId: z.string().optional(),
        seed: z.number().int().min(0).max(4294967295).optional(),
        applyTextNormalization: z.enum(["auto", "on", "off"]).optional(),
        languageCode: z.string().optional(),
        voiceSettings: z
          .object({
            stability: z.number().min(0).max(1).optional(),
            similarityBoost: z.number().min(0).max(1).optional(),
            style: z.number().min(0).max(1).optional(),
            useSpeakerBoost: z.boolean().optional(),
            speed: z.number().min(0.5).max(2).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    openai: z
      .object({
        apiKey: z.string().optional(),
        model: z.string().optional(),
        voice: z.string().optional(),
      })
      .strict()
      .optional(),
    edge: z
      .object({
        enabled: z.boolean().optional(),
        voice: z.string().optional(),
        lang: z.string().optional(),
        outputFormat: z.string().optional(),
        pitch: z.string().optional(),
        rate: z.string().optional(),
        volume: z.string().optional(),
        saveSubtitles: z.boolean().optional(),
        proxy: z.string().optional(),
        timeoutMs: z.number().int().min(1000).max(120000).optional(),
      })
      .strict()
      .optional(),
    prefsPath: z.string().optional(),
    maxTextLength: z.number().int().min(1).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
  })
  .strict()
  .optional();

export const HumanDelaySchema = z
  .object({
    mode: z.union([z.literal("off"), z.literal("natural"), z.literal("custom")]).optional(),
    minMs: z.number().int().nonnegative().optional(),
    maxMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export const CliBackendSchema = z
  .object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    output: z.union([z.literal("json"), z.literal("text"), z.literal("jsonl")]).optional(),
    resumeOutput: z.union([z.literal("json"), z.literal("text"), z.literal("jsonl")]).optional(),
    input: z.union([z.literal("arg"), z.literal("stdin")]).optional(),
    maxPromptArgChars: z.number().int().positive().optional(),
    env: z.record(z.string(), z.string()).optional(),
    clearEnv: z.array(z.string()).optional(),
    modelArg: z.string().optional(),
    modelAliases: z.record(z.string(), z.string()).optional(),
    sessionArg: z.string().optional(),
    sessionArgs: z.array(z.string()).optional(),
    resumeArgs: z.array(z.string()).optional(),
    sessionMode: z
      .union([z.literal("always"), z.literal("existing"), z.literal("none")])
      .optional(),
    sessionIdFields: z.array(z.string()).optional(),
    systemPromptArg: z.string().optional(),
    systemPromptMode: z.union([z.literal("append"), z.literal("replace")]).optional(),
    systemPromptWhen: z
      .union([z.literal("first"), z.literal("always"), z.literal("never")])
      .optional(),
    imageArg: z.string().optional(),
    imageMode: z.union([z.literal("repeat"), z.literal("list")]).optional(),
    serialize: z.boolean().optional(),
  })
  .strict();

export const normalizeAllowFrom = (values?: Array<string | number>): string[] =>
  (values ?? []).map((v) => String(v).trim()).filter(Boolean);

export const requireOpenAllowFrom = (params: {
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  message: string;
}) => {
  if (params.policy !== "open") return;
  const allow = normalizeAllowFrom(params.allowFrom);
  if (allow.includes("*")) return;
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: params.path,
    message: params.message,
  });
};

export const MSTeamsReplyStyleSchema = z.enum(["thread", "top-level"]);

export const RetryConfigSchema = z
  .object({
    attempts: z.number().int().min(1).optional(),
    minDelayMs: z.number().int().min(0).optional(),
    maxDelayMs: z.number().int().min(0).optional(),
    jitter: z.number().min(0).max(1).optional(),
  })
  .strict()
  .optional();

export const QueueModeBySurfaceSchema = z
  .object({
    whatsapp: QueueModeSchema.optional(),
    telegram: QueueModeSchema.optional(),
    discord: QueueModeSchema.optional(),
    slack: QueueModeSchema.optional(),
    mattermost: QueueModeSchema.optional(),
    signal: QueueModeSchema.optional(),
    imessage: QueueModeSchema.optional(),
    msteams: QueueModeSchema.optional(),
    webchat: QueueModeSchema.optional(),
  })
  .strict()
  .optional();

export const DebounceMsBySurfaceSchema = z
  .record(z.string(), z.number().int().nonnegative())
  .optional();

export const QueueSchema = z
  .object({
    mode: QueueModeSchema.optional(),
    byChannel: QueueModeBySurfaceSchema,
    debounceMs: z.number().int().nonnegative().optional(),
    debounceMsByChannel: DebounceMsBySurfaceSchema,
    cap: z.number().int().positive().optional(),
    drop: QueueDropSchema.optional(),
  })
  .strict()
  .optional();

export const InboundDebounceSchema = z
  .object({
    debounceMs: z.number().int().nonnegative().optional(),
    byChannel: DebounceMsBySurfaceSchema,
  })
  .strict()
  .optional();

export const TranscribeAudioSchema = z
  .object({
    command: z.array(z.string()).superRefine((value, ctx) => {
      const executable = value[0];
      if (!isSafeExecutableValue(executable)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [0],
          message: "expected safe executable name or path",
        });
      }
    }),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const HexColorSchema = z.string().regex(/^#?[0-9a-fA-F]{6}$/, "expected hex color (RRGGBB)");

export const ExecutableTokenSchema = z
  .string()
  .refine(isSafeExecutableValue, "expected safe executable name or path");

export const MediaUnderstandingScopeSchema = z
  .object({
    default: z.union([z.literal("allow"), z.literal("deny")]).optional(),
    rules: z
      .array(
        z
          .object({
            action: z.union([z.literal("allow"), z.literal("deny")]),
            match: z
              .object({
                channel: z.string().optional(),
                chatType: z
                  .union([z.literal("direct"), z.literal("group"), z.literal("channel")])
                  .optional(),
                keyPrefix: z.string().optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .optional();

export const MediaUnderstandingCapabilitiesSchema = z
  .array(z.union([z.literal("image"), z.literal("audio"), z.literal("video")]))
  .optional();

export const MediaUnderstandingAttachmentsSchema = z
  .object({
    mode: z.union([z.literal("first"), z.literal("all")]).optional(),
    maxAttachments: z.number().int().positive().optional(),
    prefer: z
      .union([z.literal("first"), z.literal("last"), z.literal("path"), z.literal("url")])
      .optional(),
  })
  .strict()
  .optional();

const DeepgramAudioSchema = z
  .object({
    detectLanguage: z.boolean().optional(),
    punctuate: z.boolean().optional(),
    smartFormat: z.boolean().optional(),
  })
  .strict()
  .optional();

const ProviderOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const ProviderOptionsSchema = z
  .record(z.string(), z.record(z.string(), ProviderOptionValueSchema))
  .optional();

export const MediaUnderstandingModelSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    capabilities: MediaUnderstandingCapabilitiesSchema,
    type: z.union([z.literal("provider"), z.literal("cli")]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    prompt: z.string().optional(),
    maxChars: z.number().int().positive().optional(),
    maxBytes: z.number().int().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    language: z.string().optional(),
    providerOptions: ProviderOptionsSchema,
    deepgram: DeepgramAudioSchema,
    baseUrl: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    profile: z.string().optional(),
    preferredProfile: z.string().optional(),
  })
  .strict()
  .optional();

export const ToolsMediaUnderstandingSchema = z
  .object({
    enabled: z.boolean().optional(),
    scope: MediaUnderstandingScopeSchema,
    maxBytes: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().optional(),
    prompt: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    language: z.string().optional(),
    providerOptions: ProviderOptionsSchema,
    deepgram: DeepgramAudioSchema,
    baseUrl: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    attachments: MediaUnderstandingAttachmentsSchema,
    models: z.array(MediaUnderstandingModelSchema).optional(),
  })
  .strict()
  .optional();

export const ToolsMediaSchema = z
  .object({
    models: z.array(MediaUnderstandingModelSchema).optional(),
    concurrency: z.number().int().positive().optional(),
    image: ToolsMediaUnderstandingSchema.optional(),
    audio: ToolsMediaUnderstandingSchema.optional(),
    video: ToolsMediaUnderstandingSchema.optional(),
  })
  .strict()
  .optional();

export const LinkModelSchema = z
  .object({
    type: z.literal("cli").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .strict();

export const ToolsLinksSchema = z
  .object({
    enabled: z.boolean().optional(),
    scope: MediaUnderstandingScopeSchema,
    maxLinks: z.number().int().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    models: z.array(LinkModelSchema).optional(),
  })
  .strict()
  .optional();

export const NativeCommandsSettingSchema = z.union([z.boolean(), z.literal("auto")]);

export const ProviderCommandsSchema = z
  .object({
    native: NativeCommandsSettingSchema.optional(),
    nativeSkills: NativeCommandsSettingSchema.optional(),
  })
  .strict()
  .optional();
