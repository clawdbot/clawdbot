import { z } from "zod";

import {
  GroupChatSchema,
  InboundDebounceSchema,
  NativeCommandsSettingSchema,
  QueueSchema,
  TtsConfigSchema,
} from "./zod-schema.core.js";

const SessionResetConfigSchema = z
  .object({
    mode: z.union([z.literal("daily"), z.literal("idle")]).optional(),
    atHour: z.number().int().min(0).max(23).optional(),
    idleMinutes: z.number().int().positive().optional(),
  })
  .strict();

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
    idleMinutes: z.number().int().positive().optional(),
    reset: SessionResetConfigSchema.optional(),
    resetByType: z
      .object({
        dm: SessionResetConfigSchema.optional(),
        group: SessionResetConfigSchema.optional(),
        thread: SessionResetConfigSchema.optional(),
      })
      .strict()
      .optional(),
    resetByChannel: z.record(z.string(), SessionResetConfigSchema).optional(),
    store: z.string().optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
    typingMode: z
      .union([
        z.literal("never"),
        z.literal("instant"),
        z.literal("thinking"),
        z.literal("message"),
      ])
      .optional(),
    mainKey: z.string().optional(),
    sendPolicy: z
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
      .optional(),
    agentToAgent: z
      .object({
        maxPingPongTurns: z.number().int().min(0).max(5).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const MessagesSchema = z
  .object({
    messagePrefix: z.string().optional(),
    responsePrefix: z.string().optional(),
    groupChat: GroupChatSchema,
    queue: QueueSchema,
    inbound: InboundDebounceSchema,
    ackReaction: z.string().optional(),
    ackReactionScope: z.enum(["group-mentions", "group-all", "direct", "all"]).optional(),
    removeAckAfterReply: z.boolean().optional(),
    tts: TtsConfigSchema,
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
    debug: z.boolean().optional(),
    restart: z.boolean().optional(),
    useAccessGroups: z.boolean().optional(),
  })
  .strict()
  .optional()
  .default({ native: "auto", nativeSkills: "auto" });
