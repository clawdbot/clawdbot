// Defines Zod schema fragments for agent default configuration.
import { z } from "zod";
import { isValidNonNegativeByteSizeString } from "./byte-size.js";
import {
  HeartbeatSchema,
  AgentSandboxSchema,
  AgentContextLimitsSchema,
  AgentModelRuntimeEntrySchema,
  AgentModelPolicySchema,
  AgentModelSchema,
  AgentToolModelSchema,
} from "./zod-schema.agent-runtime.js";
import {
  BlockStreamingChunkSchema,
  BlockStreamingCoalesceSchema,
  HumanDelaySchema,
  TypingModeSchema,
} from "./zod-schema.core.js";

const SilentReplyPolicySchema = z.union([z.literal("allow"), z.literal("disallow")]);

const NonNegativeByteSizeSchema = z.union([
  z.number().int().nonnegative(),
  z.string().refine(isValidNonNegativeByteSizeString, "Expected byte size string like 2mb"),
]);

const OptionalBootstrapFileNameSchema = z.enum([
  "SOUL.md",
  "USER.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
]);

const AgentThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
  "max",
  "ultra",
]);

const EmbeddedAgentConfigSchema = z
  .object({
    projectSettingsPolicy: z
      .union([z.literal("trusted"), z.literal("sanitize"), z.literal("ignore")])
      .optional(),
    executionContract: z.union([z.literal("default"), z.literal("strict-agentic")]).optional(),
  })
  .strict();

export const SilentReplyPolicyConfigSchema = z
  .object({
    group: SilentReplyPolicySchema.optional(),
    internal: SilentReplyPolicySchema.optional(),
  })
  .strict();

export const AgentDefaultsSchema = z
  .object({
    /** Global default provider params applied to all models before per-model and per-agent overrides. */
    params: z.record(z.string(), z.unknown()).optional(),
    model: AgentModelSchema.optional(),
    utilityModel: z.string().optional(),
    imageModel: AgentToolModelSchema.optional(),
    mediaModels: z
      .object({
        image: AgentToolModelSchema.optional(),
        video: AgentToolModelSchema.optional(),
        music: AgentToolModelSchema.optional(),
      })
      .strict()
      .optional(),
    voiceModel: AgentToolModelSchema.optional(),
    pdfModel: AgentToolModelSchema.optional(),
    pdfMaxMb: z.number().positive().optional(),
    pdfMaxPages: z.number().int().positive().optional(),
    models: z.record(z.string(), AgentModelRuntimeEntrySchema).optional(),
    modelPolicy: AgentModelPolicySchema.optional(),
    workspace: z.string().optional(),
    skills: z.array(z.string()).optional(),
    silentReply: SilentReplyPolicyConfigSchema.optional(),
    repoRoot: z.string().optional(),
    skipBootstrap: z.boolean().optional(),
    skipOptionalBootstrapFiles: z.array(OptionalBootstrapFileNameSchema).optional(),
    contextInjection: z
      .union([z.literal("always"), z.literal("continuation-skip"), z.literal("never")])
      .optional(),
    bootstrapMaxChars: z.number().int().positive().optional(),
    bootstrapTotalMaxChars: z.number().int().positive().optional(),
    experimental: z
      .object({
        localModelLean: z.boolean().optional(),
      })
      .strict()
      .optional(),
    userTimezone: z.string().optional(),
    startupContext: z
      .object({
        enabled: z.boolean().optional(),
        applyOn: z.array(z.union([z.literal("new"), z.literal("reset")])).optional(),
        dailyMemoryDays: z.number().int().min(1).max(14).optional(),
        maxFileBytes: z
          .number()
          .int()
          .min(1)
          .max(64 * 1024)
          .optional(),
        maxFileChars: z.number().int().min(1).max(10_000).optional(),
        maxTotalChars: z.number().int().min(1).max(50_000).optional(),
      })
      .strict()
      .optional(),
    contextLimits: AgentContextLimitsSchema,
    contextTokens: z.number().int().positive().optional(),
    contextPruning: z
      .object({
        mode: z.union([z.literal("off"), z.literal("cache-ttl")]).optional(),
        ttl: z.string().optional(),
        tools: z
          .object({
            allow: z.array(z.string()).optional(),
            deny: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        hardClear: z
          .object({
            enabled: z.boolean().optional(),
            placeholder: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    compaction: z
      .object({
        mode: z.union([z.literal("default"), z.literal("safeguard")]).optional(),
        provider: z.string().optional(),
        thinkingLevel: AgentThinkingLevelSchema.optional(),
        keepRecentTokens: z.number().int().positive().optional(),
        identifierPolicy: z.union([z.literal("strict"), z.literal("off")]).optional(),
        recentTurnsPreserve: z.number().int().min(0).max(12).optional(),
        qualityGuard: z
          .object({
            enabled: z.boolean().optional(),
            maxRetries: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        midTurnPrecheck: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
        postIndexSync: z.enum(["off", "async", "await"]).optional(),
        postCompactionSections: z.array(z.string()).optional(),
        model: z.string().optional(),
        timeoutSeconds: z.number().int().positive().optional(),
        memoryFlush: z
          .object({
            enabled: z.boolean().optional(),
            model: z.string().optional(),
            softThresholdTokens: z.number().int().nonnegative().optional(),
            forceFlushTranscriptBytes: NonNegativeByteSizeSchema.optional(),
          })
          .strict()
          .optional(),
        truncateAfterCompaction: z.boolean().optional(),
        maxActiveTranscriptBytes: NonNegativeByteSizeSchema.optional(),
        notifyUser: z.boolean().optional(),
      })
      .strict()
      .optional(),
    embeddedAgent: EmbeddedAgentConfigSchema.optional(),
    thinkingDefault: AgentThinkingLevelSchema.optional(),
    fastModeDefault: z.union([z.boolean(), z.literal("auto")]).optional(),
    verboseDefault: z.union([z.literal("off"), z.literal("on"), z.literal("full")]).optional(),
    toolProgressDetail: z.union([z.literal("explain"), z.literal("raw")]).optional(),
    reasoningDefault: z.union([z.literal("off"), z.literal("on"), z.literal("stream")]).optional(),
    elevatedDefault: z
      .union([z.literal("off"), z.literal("on"), z.literal("ask"), z.literal("full")])
      .optional(),
    blockStreamingDefault: z.union([z.literal("off"), z.literal("on")]).optional(),
    blockStreamingBreak: z.union([z.literal("text_end"), z.literal("message_end")]).optional(),
    blockStreamingChunk: BlockStreamingChunkSchema.optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    humanDelay: HumanDelaySchema.optional(),
    // 0 = unlimited run budget; stream liveness watchdogs still apply.
    timeoutSeconds: z.number().int().nonnegative().optional(),
    mediaMaxMb: z.number().positive().optional(),
    imageMaxDimensionPx: z.number().int().positive().optional(),
    imageQuality: z.enum(["auto", "efficient", "balanced", "high"]).optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
    typingMode: TypingModeSchema.optional(),
    heartbeat: HeartbeatSchema,
    maxConcurrent: z.number().int().positive().optional(),
    subagents: z
      .object({
        delegationMode: z.enum(["suggest", "prefer"]).optional(),
        allowAgents: z.array(z.string()).optional(),
        maxConcurrent: z.number().int().positive().optional(),
        maxSpawnDepth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe(
            "Maximum nesting depth for sub-agent spawning. 1 = no nesting (default), 2 = sub-agents can spawn sub-sub-agents.",
          ),
        maxChildrenPerAgent: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe(
            "Maximum number of active children a single agent session can spawn (default: 5).",
          ),
        archiveAfterMinutes: z.number().int().min(0).optional(),
        model: AgentModelSchema.optional(),
        thinking: z.string().optional(),
        runTimeoutSeconds: z.number().int().min(0).optional(),
        announceTimeoutMs: z.number().int().positive().optional(),
        requireAgentId: z.boolean().optional(),
      })
      .strict()
      .optional(),
    sandbox: AgentSandboxSchema,
  })
  .strict()
  .optional();
