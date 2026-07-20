// Defines core Zod schema fragments for canonical config parsing.
import path from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { z } from "zod";
import { isSafeExecutableValue } from "../infra/exec-safety.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  isValidFileSecretRefId,
} from "../secrets/ref-contract.js";
import type { ModelCompatConfig } from "./types.models.js";
import { MODEL_APIS, MODEL_THINKING_FORMATS } from "./types.models.js";
import { createAllowDenyChannelRulesSchema } from "./zod-schema.allowdeny.js";
import { sensitive } from "./zod-schema.sensitive.js";

const ENV_SECRET_REF_ID_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

function isAbsolutePath(value: string): boolean {
  // `path.isAbsolute` follows the host OS, but config files can be authored for Windows from
  // macOS/Linux. Accept Windows forms explicitly so cross-platform config validation stays stable.
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

/** Config-level secret reference schema shared by model/provider/plugin credential fields. */
export const SecretRefSchema = z.discriminatedUnion("source", [
  EnvSecretRefSchema,
  FileSecretRefSchema,
  ExecSecretRefSchema,
]);

/** Accepts either legacy inline secret strings or structured secret references. */
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

const SecretsManualExecProviderSchema = z
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

const SecretsPluginIntegrationExecProviderSchema = z
  .object({
    source: z.literal("exec"),
    pluginIntegration: z
      .object({
        pluginId: z.string().min(1).max(128),
        integrationId: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();

const SecretsExecProviderSchema = z.union([
  SecretsManualExecProviderSchema,
  SecretsPluginIntegrationExecProviderSchema,
]);

/** Schema for one configured env/file/exec secret provider entry. */
export const SecretProviderSchema = z.union([
  SecretsEnvProviderSchema,
  SecretsFileProviderSchema,
  SecretsExecProviderSchema,
]);

/** Schema for the top-level `secrets` config block. */
export const SecretsConfigSchema = z
  .object({
    providers: z
      .object({
        // Keep this as a record so users can define multiple named providers per source.
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
  })
  .strict()
  .optional();

const LEGACY_OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";
const OPENAI_CHATGPT_RESPONSES_API =
  "openai-chatgpt-responses" satisfies (typeof MODEL_APIS)[number];

const ModelApiSchema = z.enum(MODEL_APIS, {
  error: (issue) =>
    issue.input === LEGACY_OPENAI_CODEX_RESPONSES_API
      ? `"${LEGACY_OPENAI_CODEX_RESPONSES_API}" is a removed api id; use "${OPENAI_CHATGPT_RESPONSES_API}"`
      : undefined,
});

const ModelCompatSchema = z
  .object({
    supportsStore: z.boolean().optional(),
    supportsPromptCacheKey: z.boolean().optional(),
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
    supportsTemperature: z.boolean().optional(),
    supportsUsageInStreaming: z.boolean().optional(),
    supportsTools: z.boolean().optional(),
    supportsStrictMode: z.boolean().optional(),
    requiresStringContent: z.boolean().optional(),
    strictMessageKeys: z.boolean().optional(),
    visibleReasoningDetailTypes: z.array(z.string().min(1)).optional(),
    supportedReasoningEfforts: z.array(z.string().min(1)).optional(),
    reasoningEffortMap: z.record(z.string().min(1), z.string().min(1)).optional(),
    maxTokensField: z
      .union([z.literal("max_completion_tokens"), z.literal("max_tokens")])
      .optional(),
    thinkingFormat: z.enum(MODEL_THINKING_FORMATS).optional(),
    requiresToolResultName: z.boolean().optional(),
    requiresAssistantAfterToolResult: z.boolean().optional(),
    requiresThinkingAsText: z.boolean().optional(),
    requiresReasoningContentOnAssistantMessages: z.boolean().optional(),
    toolSchemaProfile: z.string().optional(),
    unsupportedToolSchemaKeywords: z.array(z.string().min(1)).optional(),
    nativeWebSearchTool: z.boolean().optional(),
    toolCallArgumentsEncoding: z.string().optional(),
    requiresMistralToolIds: z.boolean().optional(),
    requiresOpenAiAnthropicToolPayload: z.boolean().optional(),
  })
  .strict()
  .optional();
type AssertAssignable<_Left extends _Right, _Right> = true;
const modelCompatSchemaContract: [
  AssertAssignable<z.infer<typeof ModelCompatSchema>, ModelCompatConfig | undefined>,
  AssertAssignable<ModelCompatConfig | undefined, z.infer<typeof ModelCompatSchema>>,
] = [] as never;
void modelCompatSchemaContract;
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

const ModelAgentRuntimePolicySchema = z
  .object({
    id: z.string().optional(),
  })
  .strict()
  .optional();

const ModelImageInputSchema = z
  .object({
    maxBytes: z.number().int().positive().optional(),
    maxPixels: z.number().int().positive().optional(),
    maxSidePx: z.number().int().positive().optional(),
    preferredSidePx: z.number().int().positive().optional(),
    tokenMode: z.union([z.literal("tile"), z.literal("detail"), z.literal("provider")]).optional(),
  })
  .strict();

const ModelMediaInputSchema = z
  .object({
    image: ModelImageInputSchema.optional(),
  })
  .strict();

// Mirrors the runtime ThinkingLevelMap contract (model-registry TypeBox schema). Persisted model
// entries carry thinkingLevelMap, so the strict config schema must accept it or updateConfig rolls back.
const ThinkingLevelMapValueSchema = z.string().nullable();
const ThinkingLevelMapSchema = z
  .object({
    off: ThinkingLevelMapValueSchema.optional(),
    minimal: ThinkingLevelMapValueSchema.optional(),
    low: ThinkingLevelMapValueSchema.optional(),
    medium: ThinkingLevelMapValueSchema.optional(),
    high: ThinkingLevelMapValueSchema.optional(),
    xhigh: ThinkingLevelMapValueSchema.optional(),
    max: ThinkingLevelMapValueSchema.optional(),
  })
  .strict();

const ModelDefinitionSchema = z
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
    thinkingLevelMap: ThinkingLevelMapSchema.optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    agentRuntime: ModelAgentRuntimePolicySchema,
    headers: z.record(z.string(), z.string()).optional(),
    compat: ModelCompatSchema,
    mediaInput: ModelMediaInputSchema.optional(),
    metadataSource: z.literal("models-add").optional(),
  })
  .strict();

const ModelProviderLocalServiceSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string().register(sensitive)).optional(),
    healthUrl: z.string().min(1).optional(),
    readyTimeoutMs: z.number().int().positive().optional(),
    idleStopMs: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional();

const BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = new Set([
  "amazon-bedrock",
  "amazon-bedrock-mantle",
  "anthropic",
  "anthropic-vertex",
  "arcee",
  "azure-openai-responses",
  "byteplus",
  "byteplus-plan",
  "cerebras",
  "chutes",
  "claude-cli",
  "clawrouter",
  "cloudflare-ai-gateway",
  "codex",
  "comfy",
  "copilot-proxy",
  "dashscope",
  "deepinfra",
  "deepseek",
  "fal",
  "fireworks",
  "github-copilot",
  "gmi",
  "gmi-cloud",
  "gmicloud",
  "google",
  "google-antigravity",
  "google-gemini-cli",
  "google-vertex",
  "groq",
  "huggingface",
  "kilocode",
  "kimi",
  "kimi-coding",
  "litellm",
  "lmstudio",
  "meta",
  "microsoft-foundry",
  "minimax",
  "minimax-portal",
  "mistral",
  "modelstudio",
  "moonshot",
  "moonshot-ai",
  "moonshotai",
  "nvidia",
  "novita",
  "novita-ai",
  "novitaai",
  "ollama",
  "ollama-cloud",
  "openai",
  "opencode",
  "opencode-go",
  "openrouter",
  "qianfan",
  "qwen",
  "qwen-token-plan",
  "qwencloud",
  "sglang",
  "stepfun",
  "stepfun-plan",
  "synthetic",
  "tencent-tokenhub",
  "tencent-tokenplan",
  "together",
  "venice",
  "vercel-ai-gateway",
  "vllm",
  "volcengine",
  "volcengine-plan",
  "vydra",
  "x-ai",
  "xai",
  "xiaomi",
  "xiaomi-token-plan",
  "z.ai",
  "z-ai",
  "zai",
]);

export function isBuiltInModelProviderOverlayId(providerId: string): boolean {
  return BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS.has(normalizeProviderId(providerId));
}

const ModelProviderSchema = z
  .object({
    baseUrl: z.string().min(1).optional(),
    apiKey: SecretInputSchema.optional().register(sensitive),
    auth: z
      .union([z.literal("api-key"), z.literal("aws-sdk"), z.literal("oauth"), z.literal("token")])
      .optional(),
    api: ModelApiSchema.optional(),
    contextWindow: z.number().positive().optional(),
    contextTokens: z.number().int().positive().optional(),
    maxTokens: z.number().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    region: z.string().min(1).optional(),
    injectNumCtxForOpenAICompat: z.boolean().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    agentRuntime: ModelAgentRuntimePolicySchema,
    localService: ModelProviderLocalServiceSchema,
    headers: z.record(z.string(), SecretInputSchema.register(sensitive)).optional(),
    authHeader: z.boolean().optional(),
    request: ConfiguredModelProviderRequestSchema,
    models: z.array(ModelDefinitionSchema).optional(),
  })
  .strict();

const ModelProvidersSchema = z
  .record(z.string(), ModelProviderSchema)
  .superRefine((providers, ctx) => {
    for (const [providerId, provider] of Object.entries(providers)) {
      if (isBuiltInModelProviderOverlayId(providerId)) {
        continue;
      }
      if (!provider.baseUrl) {
        ctx.addIssue({
          code: "custom",
          path: [providerId, "baseUrl"],
          message:
            "custom model providers must declare baseUrl; provider overlays without baseUrl are only supported for bundled providers",
        });
      }
      if (!Array.isArray(provider.models)) {
        ctx.addIssue({
          code: "custom",
          path: [providerId, "models"],
          message:
            "custom model providers must declare models; provider overlays without models are only supported for bundled providers",
        });
      }
    }
  });

const ModelPricingConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict()
  .optional();

export const ModelsConfigSchema = z
  .object({
    mode: z.union([z.literal("merge"), z.literal("replace")]).optional(),
    providers: ModelProvidersSchema.optional(),
    pricing: ModelPricingConfigSchema,
  })
  .strict()
  .optional();

const VisibleRepliesValueSchema = z.enum(["automatic", "message_tool"]);
const AmbientGroupInboundSchema = z.enum(["user_request", "room_event"]);

export const VisibleRepliesSchema = z
  .union([VisibleRepliesValueSchema, z.boolean()])
  .overwrite((value) => {
    if (value === true) {
      return "automatic";
    }
    if (value === false) {
      return "message_tool";
    }
    return value;
  });

const MentionPatternsModeSchema = z.union([z.literal("allow"), z.literal("deny")]);

export const MentionPatternsPolicySchema = z
  .object({
    mode: MentionPatternsModeSchema.optional(),
    allowIn: z.array(z.string()).optional(),
    denyIn: z.array(z.string()).optional(),
  })
  .strict();

export const GroupChatSchema = z
  .object({
    mentionPatterns: z.array(z.string()).optional(),
    historyLimit: z.number().int().positive().optional(),
    unmentionedInbound: AmbientGroupInboundSchema.optional(),
    visibleReplies: VisibleRepliesSchema.optional(),
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

const QueueModeSchema = z.union([
  z.literal("steer"),
  z.literal("followup"),
  z.literal("collect"),
  z.literal("interrupt"),
]);
const QueueDropSchema = z.union([z.literal("old"), z.literal("new"), z.literal("summarize")]);
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

export const TextChunkModeSchema = z.enum(["length", "newline"]);

export const ChannelStreamingBlockSchema = z
  .object({
    enabled: z.boolean().optional(),
    coalesce: BlockStreamingCoalesceSchema.optional(),
  })
  .strict();

/** Delivery-only nested streaming config for channels without preview modes. */
export const ChannelDeliveryStreamingConfigSchema = z
  .object({
    chunkMode: TextChunkModeSchema.optional(),
    block: ChannelStreamingBlockSchema.optional(),
  })
  .strict();

export const ReplyRuntimeConfigSchemaShape = {
  historyLimit: z.number().int().min(0).optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  contextVisibility: ContextVisibilityModeSchema.optional(),
  dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  streaming: ChannelDeliveryStreamingConfigSchema.optional(),
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

const MarkdownTableModeSchema = z.enum(["off", "bullets", "code", "block"]);

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
    jsonlDialect: z
      .union([z.literal("claude-stream-json"), z.literal("gemini-stream-json")])
      .optional(),
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
    forkArg: z.string().optional(),
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
    reseedFromRawTranscriptWhenUncompacted: z.boolean().optional(),
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

const normalizeAllowFrom = (values?: Array<string | number>): string[] =>
  normalizeStringEntries(values);

/**
 * Closed set of sender-policy/allowFrom dependency violations. Both cases drop
 * every inbound DM at runtime, so callers surface them as config problems.
 */
export type DmPolicyAllowFromViolation = "open_requires_wildcard" | "allowlist_requires_entries";

/**
 * Canonical cross-field check for dmPolicy vs allowFrom. This is the single
 * source of truth shared by the Zod schema refinements and the CLI config
 * validator so the rule cannot drift between the two surfaces.
 */
export const evaluateDmPolicyAllowFromDependency = (params: {
  policy?: string;
  allowFrom?: Array<string | number>;
}): DmPolicyAllowFromViolation | null => {
  const allow = normalizeAllowFrom(params.allowFrom);
  if (params.policy === "open" && !allow.includes("*")) {
    return "open_requires_wildcard";
  }
  if (params.policy === "allowlist" && allow.length === 0) {
    return "allowlist_requires_entries";
  }
  return null;
};

export const requireOpenAllowFrom = (params: {
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  message: string;
}) => {
  if (
    evaluateDmPolicyAllowFromDependency({ policy: params.policy, allowFrom: params.allowFrom }) !==
    "open_requires_wildcard"
  ) {
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
  if (
    evaluateDmPolicyAllowFromDependency({ policy: params.policy, allowFrom: params.allowFrom }) !==
    "allowlist_requires_entries"
  ) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: params.path,
    message: params.message,
  });
};

export const MSTeamsReplyStyleSchema = z.enum(["thread", "top-level"]);

const QueueModeBySurfaceSchema = z
  .object({
    whatsapp: QueueModeSchema.optional(),
    telegram: QueueModeSchema.optional(),
    discord: QueueModeSchema.optional(),
    irc: QueueModeSchema.optional(),
    googlechat: QueueModeSchema.optional(),
    slack: QueueModeSchema.optional(),
    mattermost: QueueModeSchema.optional(),
    signal: QueueModeSchema.optional(),
    imessage: QueueModeSchema.optional(),
    msteams: QueueModeSchema.optional(),
    webchat: QueueModeSchema.optional(),
    matrix: QueueModeSchema.optional(),
  })
  .strict()
  .optional();

const DebounceMsBySurfaceSchema = z.record(z.string(), z.number().int().nonnegative()).optional();

export const QueueSchema = z
  .object({
    mode: QueueModeSchema.optional(),
    byChannel: QueueModeBySurfaceSchema,
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

export const HexColorSchema = z.string().regex(/^#?[0-9a-fA-F]{6}$/, "expected hex color (RRGGBB)");

export const ExecutableTokenSchema = z
  .string()
  .refine(isSafeExecutableValue, "expected safe executable name or path");

const MediaUnderstandingScopeSchema = createAllowDenyChannelRulesSchema();

const MediaUnderstandingCapabilitiesSchema = z
  .array(z.union([z.literal("image"), z.literal("audio"), z.literal("video")]))
  .optional();

const MediaUnderstandingAttachmentsSchema = z
  .object({
    mode: z.union([z.literal("first"), z.literal("all")]).optional(),
    maxAttachments: z.number().int().positive().optional(),
    prefer: z
      .union([z.literal("first"), z.literal("last"), z.literal("path"), z.literal("url")])
      .optional(),
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
  baseUrl: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  request: ConfiguredProviderRequestSchema,
};

const MediaUnderstandingModelSchema = z
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

const ToolsMediaUnderstandingSchema = z
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
    image: ToolsMediaUnderstandingSchema.optional(),
    audio: ToolsMediaUnderstandingSchema.optional(),
    video: ToolsMediaUnderstandingSchema.optional(),
  })
  .strict()
  .optional();
const LinkModelSchema = z
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
