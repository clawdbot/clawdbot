import { z } from "zod";
import {
  HeartbeatSchema,
  MemorySearchSchema,
  SandboxBrowserSchema,
  SandboxDockerSchema,
  SandboxPruneSchema,
} from "./zod-schema.agent-runtime.js";
import {
  BlockStreamingChunkSchema,
  BlockStreamingCoalesceSchema,
  CliBackendSchema,
  HumanDelaySchema,
} from "./zod-schema.core.js";

export const AgentDefaultsSchema = z
  .object({
    model: z
      .object({
        primary: z.string().optional(),
        fallbacks: z.array(z.string()).optional(),
      })
      .optional(),
    imageModel: z
      .object({
        primary: z.string().optional(),
        fallbacks: z.array(z.string()).optional(),
      })
      .optional(),
    models: z
      .record(
        z.string(),
        z.object({
          alias: z.string().optional(),
          /** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
          params: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional(),
    workspace: z.string().optional(),
    skipBootstrap: z.boolean().optional(),
    bootstrapMaxChars: z.number().int().positive().optional(),
    userTimezone: z.string().optional(),
    contextTokens: z.number().int().positive().optional(),
    cliBackends: z.record(z.string(), CliBackendSchema).optional(),
    memorySearch: MemorySearchSchema,
    contextPruning: z
      .object({
        mode: z
          .union([
            z.literal("off"),
            z.literal("adaptive"),
            z.literal("aggressive"),
          ])
          .optional(),
        keepLastAssistants: z.number().int().nonnegative().optional(),
        softTrimRatio: z.number().min(0).max(1).optional(),
        hardClearRatio: z.number().min(0).max(1).optional(),
        minPrunableToolChars: z.number().int().nonnegative().optional(),
        tools: z
          .object({
            allow: z.array(z.string()).optional(),
            deny: z.array(z.string()).optional(),
          })
          .optional(),
        softTrim: z
          .object({
            maxChars: z.number().int().nonnegative().optional(),
            headChars: z.number().int().nonnegative().optional(),
            tailChars: z.number().int().nonnegative().optional(),
          })
          .optional(),
        hardClear: z
          .object({
            enabled: z.boolean().optional(),
            placeholder: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    compaction: z
      .object({
        mode: z
          .union([z.literal("default"), z.literal("safeguard")])
          .optional(),
        reserveTokensFloor: z.number().int().nonnegative().optional(),
        memoryFlush: z
          .object({
            enabled: z.boolean().optional(),
            softThresholdTokens: z.number().int().nonnegative().optional(),
            prompt: z.string().optional(),
            systemPrompt: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    thinkingDefault: z
      .union([
        z.literal("off"),
        z.literal("minimal"),
        z.literal("low"),
        z.literal("medium"),
        z.literal("high"),
        z.literal("xhigh"),
      ])
      .optional(),
    verboseDefault: z.union([z.literal("off"), z.literal("on")]).optional(),
    elevatedDefault: z.union([z.literal("off"), z.literal("on")]).optional(),
    blockStreamingDefault: z
      .union([z.literal("off"), z.literal("on")])
      .optional(),
    blockStreamingBreak: z
      .union([z.literal("text_end"), z.literal("message_end")])
      .optional(),
    blockStreamingChunk: BlockStreamingChunkSchema.optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    humanDelay: HumanDelaySchema.optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    mediaMaxMb: z.number().positive().optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
    typingMode: z
      .union([
        z.literal("never"),
        z.literal("instant"),
        z.literal("thinking"),
        z.literal("message"),
      ])
      .optional(),
    heartbeat: HeartbeatSchema,
    maxConcurrent: z.number().int().positive().optional(),
    subagents: z
      .object({
        maxConcurrent: z.number().int().positive().optional(),
        archiveAfterMinutes: z.number().int().positive().optional(),
        model: z
          .union([
            z.string(),
            z.object({
              primary: z.string().optional(),
              fallbacks: z.array(z.string()).optional(),
            }),
          ])
          .optional(),
      })
      .optional(),
    sandbox: z
      .object({
        mode: z
          .union([z.literal("off"), z.literal("non-main"), z.literal("all")])
          .optional(),
        workspaceAccess: z
          .union([z.literal("none"), z.literal("ro"), z.literal("rw")])
          .optional(),
        sessionToolsVisibility: z
          .union([z.literal("spawned"), z.literal("all")])
          .optional(),
        scope: z
          .union([
            z.literal("session"),
            z.literal("agent"),
            z.literal("shared"),
          ])
          .optional(),
        perSession: z.boolean().optional(),
        workspaceRoot: z.string().optional(),
        docker: SandboxDockerSchema,
        browser: SandboxBrowserSchema,
        prune: SandboxPruneSchema,
      })
      .optional(),
  })
  .optional();
