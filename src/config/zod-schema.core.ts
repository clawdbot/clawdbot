import { z } from "zod";

import { isSafeExecutableValue } from "../infra/exec-safety.js";

export const ModelApiSchema = z.union([
  z.literal("openai-completions"),
  z.literal("openai-responses"),
  z.literal("anthropic-messages"),
  z.literal("google-generative-ai"),
  z.literal("github-copilot"),
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
  .optional();

export const ModelDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  api: ModelApiSchema.optional(),
  reasoning: z.boolean(),
  input: z.array(z.union([z.literal("text"), z.literal("image")])),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }),
  contextWindow: z.number().positive(),
  maxTokens: z.number().positive(),
  headers: z.record(z.string(), z.string()).optional(),
  compat: ModelCompatSchema,
});

export const ModelProviderSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  api: ModelApiSchema.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  authHeader: z.boolean().optional(),
  models: z.array(ModelDefinitionSchema),
});

export const ModelsConfigSchema = z
  .object({
    mode: z.union([z.literal("merge"), z.literal("replace")]).optional(),
    providers: z.record(z.string(), ModelProviderSchema).optional(),
  })
  .optional();

export const GroupChatSchema = z
  .object({
    mentionPatterns: z.array(z.string()).optional(),
    historyLimit: z.number().int().positive().optional(),
  })
  .optional();

export const DmConfigSchema = z.object({
  historyLimit: z.number().int().min(0).optional(),
});

export const IdentitySchema = z
  .object({
    name: z.string().optional(),
    theme: z.string().optional(),
    emoji: z.string().optional(),
  })
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
]);

// GroupPolicySchema: controls how group messages are handled
// Used with .default("allowlist").optional() pattern:
//   - .optional() allows field omission in input config
//   - .default("allowlist") ensures runtime always resolves to "allowlist" if not provided
export const GroupPolicySchema = z.enum(["open", "disabled", "allowlist"]);

export const DmPolicySchema = z.enum([
  "pairing",
  "allowlist",
  "open",
  "disabled",
]);

export const BlockStreamingCoalesceSchema = z.object({
  minChars: z.number().int().positive().optional(),
  maxChars: z.number().int().positive().optional(),
  idleMs: z.number().int().nonnegative().optional(),
});

export const BlockStreamingChunkSchema = z.object({
  minChars: z.number().int().positive().optional(),
  maxChars: z.number().int().positive().optional(),
  breakPreference: z
    .union([
      z.literal("paragraph"),
      z.literal("newline"),
      z.literal("sentence"),
    ])
    .optional(),
});

export const HumanDelaySchema = z.object({
  mode: z
    .union([z.literal("off"), z.literal("natural"), z.literal("custom")])
    .optional(),
  minMs: z.number().int().nonnegative().optional(),
  maxMs: z.number().int().nonnegative().optional(),
});

export const CliBackendSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  output: z
    .union([z.literal("json"), z.literal("text"), z.literal("jsonl")])
    .optional(),
  resumeOutput: z
    .union([z.literal("json"), z.literal("text"), z.literal("jsonl")])
    .optional(),
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
  systemPromptMode: z
    .union([z.literal("append"), z.literal("replace")])
    .optional(),
  systemPromptWhen: z
    .union([z.literal("first"), z.literal("always"), z.literal("never")])
    .optional(),
  imageArg: z.string().optional(),
  imageMode: z.union([z.literal("repeat"), z.literal("list")]).optional(),
  serialize: z.boolean().optional(),
});

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
  .optional();

export const QueueModeBySurfaceSchema = z
  .object({
    whatsapp: QueueModeSchema.optional(),
    telegram: QueueModeSchema.optional(),
    discord: QueueModeSchema.optional(),
    slack: QueueModeSchema.optional(),
    signal: QueueModeSchema.optional(),
    imessage: QueueModeSchema.optional(),
    msteams: QueueModeSchema.optional(),
    webchat: QueueModeSchema.optional(),
  })
  .optional();

export const QueueSchema = z
  .object({
    mode: QueueModeSchema.optional(),
    byChannel: QueueModeBySurfaceSchema,
    debounceMs: z.number().int().nonnegative().optional(),
    cap: z.number().int().positive().optional(),
    drop: QueueDropSchema.optional(),
  })
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
  .optional();

export const HexColorSchema = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/, "expected hex color (RRGGBB)");

export const ExecutableTokenSchema = z
  .string()
  .refine(isSafeExecutableValue, "expected safe executable name or path");

export const ToolsAudioTranscriptionSchema = z
  .object({
    args: z.array(z.string()).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .optional();

export const NativeCommandsSettingSchema = z.union([
  z.boolean(),
  z.literal("auto"),
]);

export const ProviderCommandsSchema = z
  .object({
    native: NativeCommandsSettingSchema.optional(),
  })
  .optional();
