// Defines session-related Zod schema fragments for config parsing.
import { normalizeStringifiedOptionalString } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import { parseByteSize } from "../cli/parse-bytes.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { ElevatedAllowFromSchema } from "./zod-schema.agent-runtime.js";
import { createAllowDenyChannelRulesSchema } from "./zod-schema.allowdeny.js";
import {
  GroupChatSchema,
  InboundDebounceSchema,
  NativeCommandsSettingSchema,
  QueueSchema,
  VisibleRepliesSchema,
} from "./zod-schema.core.js";

const SessionResetConfigSchema = z
  .object({
    mode: z.union([z.literal("none"), z.literal("daily"), z.literal("idle")]).optional(),
    atHour: z.number().int().min(0).max(23).optional(),
    idleMinutes: z.number().int().positive().optional(),
  })
  .strict();

const PositiveDurationSchema = z.union([z.string(), z.number()]).superRefine((value, ctx) => {
  try {
    const ms = parseDurationMs(normalizeStringifiedOptionalString(value) ?? "", {
      defaultUnit: "d",
    });
    if (ms <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duration must be positive (use ms, s, m, h, d), e.g. 30d",
      });
    }
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "invalid duration (use ms, s, m, h, d)",
    });
  }
});

export const SessionSendPolicySchema = createAllowDenyChannelRulesSchema();

export const SessionSchema = z
  .object({
    scope: z.union([z.literal("per-sender"), z.literal("global")]).optional(),
    dmScope: z
      .union([
        z.literal("main"),
        z.literal("per-peer"),
        z.literal("per-channel-peer"),
        z.literal("per-account-channel-peer"),
      ])
      .optional(),
    identityLinks: z.record(z.string(), z.array(z.string())).optional(),
    resetTriggers: z.array(z.string()).optional(),
    reset: SessionResetConfigSchema.optional(),
    resetByType: z
      .object({
        direct: SessionResetConfigSchema.optional(),
        group: SessionResetConfigSchema.optional(),
        thread: SessionResetConfigSchema.optional(),
      })
      .strict()
      .optional(),
    resetByChannel: z.record(z.string(), SessionResetConfigSchema).optional(),
    store: z.string().optional(),
    mainKey: z.string().optional(),
    sendPolicy: SessionSendPolicySchema.optional(),
    threadBindings: z
      .object({
        enabled: z.boolean().optional(),
        idleHours: z.number().nonnegative().optional(),
        maxAgeHours: z.number().nonnegative().optional(),
        spawnSessions: z.boolean().optional(),
        defaultSpawnContext: z.enum(["isolated", "fork"]).optional(),
      })
      .strict()
      .optional(),
    sharing: z
      .object({
        readOnly: z.boolean().optional(),
        suggest: z.boolean().optional(),
        drafts: z.boolean().optional(),
      })
      .strict()
      .optional(),
    maintenance: z
      .object({
        mode: z.enum(["enforce", "warn"]).optional(),
        pruneAfter: PositiveDurationSchema.optional(),
        maxEntries: z.number().int().positive().optional(),
        resetArchiveRetention: z.union([PositiveDurationSchema, z.literal(false)]).optional(),
        maxDiskBytes: z.union([z.string(), z.number(), z.literal(false)]).optional(),
        highWaterBytes: z.union([z.string(), z.number()]).optional(),
      })
      .strict()
      .superRefine((val, ctx) => {
        if (val.maxDiskBytes !== undefined && val.maxDiskBytes !== false) {
          try {
            parseByteSize(normalizeStringifiedOptionalString(val.maxDiskBytes) ?? "", {
              defaultUnit: "b",
            });
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["maxDiskBytes"],
              message: "invalid size (use b, kb, mb, gb, tb)",
            });
          }
        }
        if (val.highWaterBytes !== undefined) {
          try {
            parseByteSize(normalizeStringifiedOptionalString(val.highWaterBytes) ?? "", {
              defaultUnit: "b",
            });
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["highWaterBytes"],
              message: "invalid size (use b, kb, mb, gb, tb)",
            });
          }
        }
      })
      .optional(),
  })
  .strict()
  .optional();

const ResponseUsageModeSchema = z.enum(["on", "off", "tokens", "full"]);

export const MessagesSchema = z
  .object({
    visibleReplies: VisibleRepliesSchema.optional(),
    responsePrefix: z.string().optional(),
    usageTemplate: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    responseUsage: z
      .union([ResponseUsageModeSchema, z.record(z.string(), ResponseUsageModeSchema)])
      .optional(),
    groupChat: GroupChatSchema,
    queue: QueueSchema,
    inbound: InboundDebounceSchema,
    ackReaction: z.string().optional(),
    ackReactionScope: z
      .enum(["group-mentions", "group-all", "direct", "all", "off", "none"])
      .optional(),
    statusReactions: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    suppressToolErrors: z.boolean().optional(),
  })
  .strict()
  .optional();

export const CommandsSchema = z
  .object({
    native: NativeCommandsSettingSchema.optional().default("auto"),
    nativeSkills: NativeCommandsSettingSchema.optional().default("auto"),
    text: z.boolean().optional(),
    bash: z.boolean().optional(),
    bashForegroundMs: z.number().int().min(0).max(30_000).optional(),
    config: z.boolean().optional(),
    mcp: z.boolean().optional(),
    plugins: z.boolean().optional(),
    debug: z.boolean().optional(),
    restart: z.boolean().optional().default(true),
    ownerAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    allowFrom: ElevatedAllowFromSchema.optional(),
  })
  .strict()
  .optional()
  .default(
    () =>
      ({
        native: "auto",
        nativeSkills: "auto",
        restart: true,
      }) as const,
  );
