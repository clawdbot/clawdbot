import path from "node:path";
import { z } from "zod";
import { isSafeExecutableValue } from "../infra/exec-safety.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  isValidFileSecretRefId,
} from "../secrets/ref-contract.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import type { ModelCompatConfig } from "./types.models.js";
import { MODEL_APIS } from "./types.models.js";
import type { MediaToolsConfig } from "./types.tools.js";
import { createAllowDenyChannelRulesSchema } from "./zod-schema.allowdeny.js";
import { sensitive } from "./zod-schema.sensitive.js";

const ENV_SECRET_REF_ID_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

function isAbsolutePath(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    WINDOWS_ABS_PATH_PATTERN.test(value) ||
    WINDOWS_UNC_PATH_PATTERN.test(value)
  );
}

const EnvSecretRefSchema = z
  .object({
    source: z.literal("env"),
    provider: z
      .string()
      .regex(
        SECRET_PROVIDER_ALIAS_PATTERN,
        'Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").',
      ),
    id: z
      .string()
      .regex(
        ENV_SECRET_REF_ID_PATTERN,
        'Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: "OPENAI_API_KEY").',
      ),
  })
  .strict();

const FileSecretRefSchema = z
  .object({
    source: z.literal("file"),
    provider: z
      .string()
      .regex(
        SECRET_PROVIDER_ALIAS_PATTERN,
        'Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").',
      ),
    id: z
      .string()
      .refine(
        isValidFileSecretRefId,
        'File secret reference id must be an absolute JSON pointer (example: "/providers/openai/apiKey"), or "value" for singleValue mode.',
      ),
  })
  .strict();

const ExecSecretRefSchema = z
  .object({
    source: z.literal("exec"),
    provider: z
      .string()
      .regex(
        SECRET_PROVIDER_ALIAS_PATTERN,
        'Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").',
      ),
    id: z.string().refine(isValidExecSecretRefId, formatExecSecretRefIdValidationMessage()),
  })
  .strict();

export const SecretRefSchema = z.discriminatedUnion("source", [
  EnvSecretRefSchema,
  FileSecretRefSchema,
  ExecSecretRefSchema,
]);

export const SecretInputSchema = z.union([z.string(), SecretRefSchema]);

const SecretsEnvProviderSchema = z
  .object({
    source: z.literal("env"),
    allowlist: z.array(z.string().regex(ENV_SECRET_REF_ID_PATTERN)).max(256).optional(),
  })
  .strict();

const SecretsFileProviderSchema = z
  .object({
    source: z.literal("file"),
    path: z.string().min(1),
    mode: z.union([z.literal("singleValue"), z.literal("json")]).optional(),
    timeoutMs: z.number().int().positive().max(120000).optional(),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024)
      .optional(),
    allowInsecurePath: z.boolean().optional(),
  })
  .strict();

const SecretsExecProviderSchema = z
  .object({
    source: z.literal("exec"),
    command: z
      .string()
      .min(1)
      .refine((value) => isSafeExecutableValue(value), "secrets.providers.*.command is unsafe.")
      .refine(
        (value) => isAbsolutePath(value),
        "secrets.providers.*.command must be an absolute path.",
      ),
    args: z.array(z.string().max(1024)).max(128).optional(),
    timeoutMs: z.number().int().positive().max(120000).optional(),
    noOutputTimeoutMs: z.number().int().positive().max(120000).optional(),
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024)
      .optional(),
    jsonOnly: z.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
    passEnv: z.array(z.string().regex(ENV_SECRET_REF_ID_PATTERN)).max(128).optional(),
    trustedDirs: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => isAbsolutePath(value), "trustedDirs entries must be absolute paths."),
      )
      .max(64)
      .optional(),
    allowInsecurePath: z.boolean().optional(),
    allowSymlinkCommand: z.boolean().optional(),
  })
  .strict();

export const SecretProviderSchema = z.discriminatedUnion("source", [
  SecretsEnvProviderSchema,
  SecretsFileProviderSchema,
  SecretsExecProviderSchema,
]);

export const SecretsConfigSchema = z
  .object({
    providers: z
      .object({
        // Keep this as a record so users can define multiple providers per source.
      })
      .catchall(SecretProviderSchema)
      .optional(),
    defaults: z
      .object({
        env: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
        file: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
        exec: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
      })
      .strict()
      .optional(),
    resolution: z
      .object({
        maxProviderConcurrency: z.number().int().positive().max(16).optional(),
        maxRefsPerProvider: z.number().int().positive().max(4096).optional(),
        maxBatchBytes: z
          .number()
          .int()
          .positive()
          .max(5 * 1024 * 1024)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const ModelApiSchema = z.enum(MODEL_APIS);

export const ModelCompatSchema = z
  .object({
    supportsStore: z.boolean().optional(),
    supportsPromptCacheKey: z.boolean().optional(),
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
    supportsUsageInStreaming: z.boolean().optional(),
    supportsTools: z.boolean().optional(),
    supportsStrictMode: z.boolean().optional(),
    requiresStringContent: z.boolean().optional(),
    visibleReasoningDetailTypes: z.array(z.string().min(1)).optional(),
    supportedReasoningEfforts: z.array(z.string().min(1)).optional(),
    reasoningEffortMap: z.record(z.string().min(1), z.string().min(1)).optional(),
    maxTokensField: z
      .union([z.literal("max_completion_tokens"), z.literal("max_tokens")])
      .optional(),
    thinkingFormat: z
      .union([
        z.literal("openai"),
        z.literal("openrouter"),
        z.literal("deepseek"),
        z.literal("zai"),
      ])
      .optional(),
    requiresToolResultName: z.boolean().optional(),
    requiresAssistantAfterToolResult: z.boolean().optional(),
    requiresThinkingAsText: z.boolean().optional(),
    toolSchemaProfile: z.string().optional(),
    unsupportedToolSchemaKeywords: z.array(z.string().min(1)).optional(),
    nativeWebSearchTool: z.boolean().optional(),
    toolCallArgumentsEncoding: z.string().optional(),
    requiresMistralToolIds: z.boolean().optional(),
    requiresOpenAiAnthropicToolPayload: z.boolean().optional(),
  })
  .strict()
  .optional();

type AssertAssignable<_T extends U, U> = true;
type _ModelCompatSchemaAssignableToType = AssertAssignable<
  z.infer<typeof ModelCompatSchema>,
  ModelCompatConfig | undefined
>;
type _ModelCompatTypeAssignableToSchema = AssertAssignable<
  ModelCompatConfig | undefined,
  z.infer<typeof ModelCompatSchema>
>;

const ConfiguredProviderRequestTlsSchema = z
  .object({
    ca: SecretInputSchema.optional().register(sensitive),
    cert: SecretInputSchema.optional().register(sensitive),
    key: SecretInputSchema.optional().register(sensitive),
    passphrase: SecretInputSchema.optional().register(sensitive),
    serverName: z.string().optional(),
    insecureSkipVerify: z.boolean().optional(),
  })
  .strict()
  .optional();

const ConfiguredProviderRequestAuthSchema = z
  .union([
    z
      .object({
        mode: z.literal("provider-default"),
      })
      .strict(),
    z
      .object({
        mode: z.literal("authorization-bearer"),
        token: SecretInputSchema.register(sensitive),
      })
      .strict(),
    z
      .object({
        mode: z.literal("header"),
        headerName: z.string().min(1),
        value: SecretInputSchema.register(sensitive),
        prefix: z.string().optional(),
      })
      .strict(),
  ])
  .optional();

const ConfiguredProviderRequestProxySchema = z
  .union([
    z
      .object({
        mode: z.literal("env-proxy"),
        tls: ConfiguredProviderRequestTlsSchema,
      })
      .strict(),
    z
      .object({
        mode: z.literal("explicit-proxy"),
        url: z.string().min(1),
        tls: ConfiguredProviderRequestTlsSchema,
      })
      .strict(),
  ])
  .optional();

const ConfiguredProviderRequestFields = {
  headers: z.record(z.string(), SecretInputSchema.register(sensitive)).optional(),
  auth: ConfiguredProviderRequestAuthSchema,
  proxy: ConfiguredProviderRequestProxySchema,
  tls: ConfiguredProviderRequestTlsSchema,
};

const ConfiguredProviderRequestSchema = z
  .object(ConfiguredProviderRequestFields)
  .strict()
  .optional();

const ConfiguredModelProviderRequestSchema = z
  .object({
    ...ConfiguredProviderRequestFields,
    allowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .optional();

export const ModelDefinitionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    api: ModelApiSchema.optional(),
    baseUrl: z.string().min(1).optional(),
    reasoning: z.boolean().optional(),
    input: z
      .array(
        z.union([z.literal("text"), z.literal("image"), z.literal("video"), z.literal("audio")]),
      )
      .optional(),
    cost: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        cacheRead: z.number().optional(),
        cacheWrite: z.number().optional(),
        tieredPricing: z
          .array(
            z
              .object({
                input: z.number(),
                output: z.number(),
                cacheRead: z.number(),
                cacheWrite: z.number(),
                range: z.union([z.tuple([z.number(), z.number()]), z.tuple([z.number()])]),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    contextWindow: z.number().positive().optional(),
    contextTokens: z.number().int().positive().optional(),
    maxTokens: z.number().positive().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    compat: ModelCompatSchema,
    metadataSource: z.literal("models-add").optional(),
  })
  .strict();

export const ModelProviderSchema = z
  .object({
    baseUrl: z.string().min(1),
    apiKey: SecretInputSchema.optional().register(sensitive),
    auth: z
      .union([z.literal("api-key"), z.literal("aws-sdk"), z.literal("oauth"), z.literal("token")])
      .optional(),
    api: ModelApiSchema.optional(),
    contextWindow: z.number().positive().optional(),
    contextTokens: z.number().int().positive().optional(),
    maxTokens: z.number().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    injectNumCtxForOpenAICompat: z.boolean().optional(),
    headers: z.record(z.string(), SecretInputSchema.register(sensitive)).optional(),
    authHeader: z.boolean().optional(),
    request: ConfiguredModelProviderRequestSchema,
    models: z.array(ModelDefinitionSchema),
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

const ModelPricingConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict()
  .optional();

export const ModelsConfigSchema = z
  .object({
    mode: z.union([z.literal("merge"), z.literal("replace")]).optional(),
    providers: z.record(z.string(), ModelProviderSchema).optional(),
    pricing: ModelPricingConfigSchema,
  })
  .strict()
  .optional();

export const GroupChatSchema = z
  .object({
    mentionPatterns: z.array(z.string()).optional(),
    historyLimit: z.number().int().positive().optional(),
    visibleReplies: z.enum(["automatic", "message_tool"]).optional(),
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
export const ReplyToModeSchema = z.union([
  z.literal("off"),
  z.literal("first"),
  z.literal("all"),
  z.literal("batched"),
]);
export const TypingModeSchema = z.union([
  z.literal("never"),
  z.literal("instant"),
  z.literal("thinking"),
  z.literal("message"),
]);

// GroupPolicySchema: controls how group messages are handled
// Used with .default("allowlist").optional() pattern:
//   - .optional() allows field omission in input config
//   - .default("allowlist") ensures runtime always resolves to "allowlist" if not provided
export const GroupPolicySchema = z.enum(["open", "disabled", "allowlist"]);

export const DmPolicySchema = z.enum(["pairing", "allowlist", "open", "disabled"]);
export const ContextVisibilityModeSchema = z.enum(["all", "allowlist", "allowlist_quote"]);

export const BlockStreamingCoalesceSchema = z
  .object({
    minChars: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().optional(),
    idleMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export const ReplyRuntimeConfigSchemaShape = {
  historyLimit: z.number().int().min(0).optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  contextVisibility: ContextVisibilityModeSchema.optional(),
  dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  chunkMode: z.enum(["length", "newline"]).optional(),
  blockStreaming: z.boolean().optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
  responsePrefix: z.string().optional(),
  mediaMaxMb: z.number().positive().optional(),
};

export const BlockStreamingChunkSchema = z
  .object({
    minChars: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().optional(),
    breakPreference: z
      .union([z.literal("paragraph"), z.literal("newline"), z.literal("sentence")])
      .optional(),
  })
  .strict();

export const MarkdownTableModeSchema = z.enum(["off", "bullets", "code", "block"]);

export const MarkdownConfigSchema = z
  .object({
    tables: MarkdownTableModeSchema.optional(),
  })
  .strict()
  .optional();

export const TtsProviderSchema = z.string().min(1);
export const TtsModeSchema = z.enum(["final", "all"]);
export const TtsAutoSchema = z.enum(["off", "always", "inbound", "tagged"]);
const TtsProviderConfigSchema = z
  .object({
    apiKey: SecretInputSchema.optional().register(sensitive),
  })
  .catchall(
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.unknown()),
      z.record(z.string(), z.unknown()),
    ]),
  );
const TtsPersonaPromptSchema = z
  .object({
    profile: z.string().optional(),
    scene: z.string().optional(),
    sampleContext: z.string().optional(),
    style: z.string().optional(),
    accent: z.string().optional(),
    pacing: z.string().optional(),
    constraints: z.array(z.string()).optional(),
  })
  .strict();
const TtsPersonaSchema = z
  .object({
    label: z.string().optional(),
    description: z.string().optional(),
    provider: TtsProviderSchema.optional(),
    fallbackPolicy: z
      .union([z.literal("preserve-persona"), z.literal("provider-defaults"), z.literal("fail")])
      .optional(),
    prompt: TtsPersonaPromptSchema.optional(),
    providers: z.record(z.string(), TtsProviderConfigSchema).optional(),
  })
  .strict();
export const TtsConfigSchema = z
  .object({
    auto: TtsAutoSchema.optional(),
    enabled: z.boolean().optional(),
    mode: TtsModeSchema.optional(),
    provider: TtsProviderSchema.optional(),
    persona: z.string().optional(),
    personas: z.record(z.string(), TtsPersonaSchema).optional(),
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
    providers: z.record(z.string(), TtsProviderConfigSchema).optional(),
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

const CliBackendWatchdogModeSchema = z
  .object({
    noOutputTimeoutMs: z.number().int().min(1000).optional(),
    noOutputTimeoutRatio: z.number().min(0.05).max(0.95).optional(),
    minMs: z.number().int().min(1000).optional(),
    maxMs: z.number().int().min(1000).optional(),
  })
  .strict()
  .optional();

export const CliBackendSchema = z
  .object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    output: z.union([z.literal("json"), z.literal("text"), z.literal("jsonl")]).optional(),
    resumeOutput: z.union([z.literal("json"), z.literal("text"), z.literal("jsonl")]).optional(),
    jsonlDialect: z.literal("claude-stream-json").optional(),
    liveSession: z.literal("claude-stdio").optional(),
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
    systemPromptFileArg: z.string().optional(),
    systemPromptFileConfigArg: z.string().optional(),
    systemPromptFileConfigKey: z.string().optional(),
    systemPromptMode: z.union([z.literal("append"), z.literal("replace")]).optional(),
    systemPromptWhen: z
      .union([z.literal("first"), z.literal("always"), z.literal("never")])
      .optional(),
    imageArg: z.string().optional(),
    imageMode: z.union([z.literal("repeat"), z.literal("list")]).optional(),
    imagePathScope: z.union([z.literal("temp"), z.literal("workspace")]).optional(),
    serialize: z.boolean().optional(),
    reliability: z
      .object({
        watchdog: z
          .object({
            fresh: CliBackendWatchdogModeSchema,
            resume: CliBackendWatchdogModeSchema,
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const normalizeAllowFrom = (values?: Array<string | number>): string[] =>
  normalizeStringEntries(values);

export const requireOpenAllowFrom = (params: {
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  message: string;
}) => {
  if (params.policy !== "open") {
    return;
  }
  const allow = normalizeAllowFrom(params.allowFrom);
  if (allow.includes("*")) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: params.path,
    message: params.message,
  });
};

/**
 * Validate that dmPolicy="allowlist" has a non-empty allowFrom array.
 * Without this, all DMs are silently dropped because the allowlist is empty
 * and no senders can match.
 */
export const requireAllowlistAllowFrom = (params: {
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  message: string;
}) => {
  if (params.policy !== "allowlist") {
    return;
  }
  const allow = normalizeAllowFrom(params.allowFrom);
  if (allow.length > 0) {
    return;
  }
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
    irc: QueueModeSchema.optional(),
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

export const MediaUnderstandingScopeSchema = createAllowDenyChannelRulesSchema();

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

const MediaUnderstandingRuntimeFields = {
  prompt: z.string().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  language: z.string().optional(),
  providerOptions: ProviderOptionsSchema,
  deepgram: DeepgramAudioSchema,
  baseUrl: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  request: ConfiguredProviderRequestSchema,
};

export const MediaUnderstandingModelSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    capabilities: MediaUnderstandingCapabilitiesSchema,
    type: z.union([z.literal("provider"), z.literal("cli")]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    maxChars: z.number().int().positive().optional(),
    maxBytes: z.number().int().positive().optional(),
    ...MediaUnderstandingRuntimeFields,
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
    ...MediaUnderstandingRuntimeFields,
    attachments: MediaUnderstandingAttachmentsSchema,
    models: z.array(MediaUnderstandingModelSchema).optional(),
    echoTranscript: z.boolean().optional(),
    echoFormat: z.string().optional(),
  })
  .strict()
  .optional();

export const ToolsMediaSchema = z
  .object({
    models: z.array(MediaUnderstandingModelSchema).optional(),
    concurrency: z.number().int().positive().optional(),
    asyncCompletion: z
      .object({
        directSend: z.boolean().optional(),
      })
      .strict()
      .optional(),
    image: ToolsMediaUnderstandingSchema.optional(),
    audio: ToolsMediaUnderstandingSchema.optional(),
    video: ToolsMediaUnderstandingSchema.optional(),
  })
  .strict()
  .optional();

type ToolsMediaConfigFromSchema = NonNullable<z.infer<typeof ToolsMediaSchema>>;
type _ToolsMediaAsyncCompletionSchemaAssignableToType = AssertAssignable<
  ToolsMediaConfigFromSchema["asyncCompletion"],
  MediaToolsConfig["asyncCompletion"]
>;
type _ToolsMediaAsyncCompletionTypeAssignableToSchema = AssertAssignable<
  MediaToolsConfig["asyncCompletion"],
  ToolsMediaConfigFromSchema["asyncCompletion"]
>;

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
