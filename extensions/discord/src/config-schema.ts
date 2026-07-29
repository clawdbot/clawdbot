// Discord helper module supports config schema behavior.
import {
  buildChannelAllowBotsSchema,
  buildChannelConfigSchema,
  buildChannelExecApprovalsSchema,
  buildChannelReactionShape,
  buildCommonChannelAccountShape,
  buildGroupEntrySchema,
  ChannelBotLoopProtectionSchema,
  ChannelDangerouslyAllowNameMatchingSchema,
  ChannelPreviewStreamingConfigSchema,
  ChannelStreamingProgressSchema,
  ProviderCommandsSchema,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
  TtsConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import {
  buildSecretInputSchema,
  registerSensitiveConfigSchema,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import { discordChannelConfigUiHints } from "./config-ui-hints.js";

const SecretInputSchema = buildSecretInputSchema();
const DiscordPreviewStreamingConfigSchema = ChannelPreviewStreamingConfigSchema.extend({
  progress: ChannelStreamingProgressSchema.optional(),
}).strict();

const DiscordIdSchema = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Discord ID "${String(value)}" is not a valid non-negative safe integer. ` +
            `Wrap it in quotes in your config file.`,
        });
        return z.NEVER;
      }
      return String(value);
    }
    return value;
  })
  .pipe(z.string());

const DiscordIdListSchema = z.array(DiscordIdSchema);
const DiscordSnowflakeStringSchema = z.string().regex(/^\d+$/, "Discord user ID must be numeric");

const DiscordDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    groupEnabled: z.boolean().optional(),
    groupChannels: DiscordIdListSchema.optional(),
  })
  .strict();

const DiscordPresenceEventsSchema = z
  .object({
    enabled: z.boolean().optional(),
    channelId: DiscordSnowflakeStringSchema,
    users: z.array(DiscordSnowflakeStringSchema).optional(),
    reconnectSuppressSeconds: z.number().int().min(0).optional(),
    burstLimit: z.number().int().positive().optional(),
    burstWindowSeconds: z.number().int().positive().optional(),
  })
  .strict();

const DiscordThreadSchema = z
  .object({
    inheritParent: z.boolean().optional(),
  })
  .strict();

const DiscordGuildChannelSchema = buildGroupEntrySchema(
  {
    ignoreOtherMentions: z.boolean().optional(),
    users: DiscordIdListSchema.optional(),
    roles: DiscordIdListSchema.optional(),
    includeThreadStarter: z.boolean().optional(),
    autoThread: z.boolean().optional(),
    /** Naming strategy for auto-created threads. "message" uses message text; "generated" creates an LLM title after thread creation. */
    autoThreadName: z.enum(["message", "generated"]).optional(),
    /** Archive duration for auto-created threads in minutes. Discord supports 60, 1440 (1 day), 4320 (3 days), 10080 (1 week). Default: 60. */
    autoArchiveDuration: z
      .union([
        z.enum(["60", "1440", "4320", "10080"]),
        z.literal(60),
        z.literal(1440),
        z.literal(4320),
        z.literal(10080),
      ])
      .optional(),
  },
  { omit: ["allowFrom"] },
);

const DiscordGuildSchema = buildGroupEntrySchema(
  {
    slug: z.string().optional(),
    ignoreOtherMentions: z.boolean().optional(),
    ...buildChannelReactionShape({
      notificationModes: ["off", "own", "all", "allowlist"],
    }),
    users: DiscordIdListSchema.optional(),
    roles: DiscordIdListSchema.optional(),
    presenceEvents: DiscordPresenceEventsSchema.optional(),
    channels: z.record(z.string(), DiscordGuildChannelSchema.optional()).optional(),
  },
  { omit: ["enabled", "skills", "allowFrom", "systemPrompt"] },
);

const DiscordVoiceAutoJoinSchema = z
  .object({
    guildId: z.string().min(1),
    channelId: z.string().min(1),
  })
  .strict();

const DiscordVoiceAllowedChannelSchema = z
  .object({
    guildId: z.string().min(1),
    channelId: z.string().min(1),
  })
  .strict();

const DiscordVoiceRealtimeToolPolicySchema = z.enum(["safe-read-only", "owner", "none"]);
const DiscordVoiceRealtimeConsultPolicySchema = z.enum(["auto", "always"]);
const DiscordVoiceRealtimeBootstrapContextFileSchema = z.enum([
  "IDENTITY.md",
  "USER.md",
  "SOUL.md",
]);
const DiscordVoiceRealtimeWakeNameSchema = z
  .string()
  .min(1)
  .regex(/^\s*[^a-z0-9]*[a-z0-9]+(?:[^a-z0-9]+[a-z0-9]+)?[^a-z0-9]*\s*$/i, {
    message: "Discord realtime wake names must be one or two words.",
  });
const DiscordVoiceRealtimeSchema = z
  .object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    speakerVoice: z.string().min(1).optional(),
    speakerVoiceId: z.string().min(1).optional(),
    instructions: z.string().min(1).optional(),
    toolPolicy: DiscordVoiceRealtimeToolPolicySchema.optional(),
    consultPolicy: DiscordVoiceRealtimeConsultPolicySchema.optional(),
    requireWakeName: z.boolean().optional(),
    wakeNames: z.array(DiscordVoiceRealtimeWakeNameSchema).min(1).optional(),
    bootstrapContextFiles: z.array(DiscordVoiceRealtimeBootstrapContextFileSchema).optional(),
    bargeIn: z.boolean().optional(),
    minBargeInAudioEndMs: z.number().int().min(0).max(10_000).optional(),
    debounceMs: z.number().int().positive().max(10_000).optional(),
    providers: z.record(z.string(), z.record(z.string(), z.unknown()).optional()).optional(),
  })
  .strict();

const DiscordVoiceAgentSessionSchema = z
  .object({
    mode: z.enum(["voice", "target"]).optional(),
    target: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "target" && !value.target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: 'voice.agentSession.target is required when mode is "target"',
      });
    }
  });

const DiscordVoiceSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(["stt-tts", "agent-proxy", "bidi"]).optional(),
    agentSession: DiscordVoiceAgentSessionSchema.optional(),
    model: z.string().min(1).optional(),
    realtime: DiscordVoiceRealtimeSchema.optional(),
    autoJoin: z.array(DiscordVoiceAutoJoinSchema).optional(),
    followUsersEnabled: z.boolean().optional(),
    followUsers: z.array(z.string().min(1)).optional(),
    allowedChannels: z.array(DiscordVoiceAllowedChannelSchema).optional(),
    daveEncryption: z.boolean().optional(),
    decryptionFailureTolerance: z.number().int().min(0).optional(),
    connectTimeoutMs: z.number().int().positive().max(120_000).optional(),
    reconnectGraceMs: z.number().int().positive().max(120_000).optional(),
    captureSilenceGraceMs: z.number().int().positive().max(30_000).optional(),
    tts: TtsConfigSchema.optional(),
  })
  .strict()
  .optional();

const DiscordAccountSchema = z
  .object({
    ...buildCommonChannelAccountShape({
      omit: ["groupAllowFrom"],
      groupPolicyDefault: true,
      allowFrom: DiscordIdListSchema.optional(),
      streaming: DiscordPreviewStreamingConfigSchema.optional(),
    }),
    commands: ProviderCommandsSchema,
    token: registerSensitiveConfigSchema(SecretInputSchema.optional()),
    applicationId: DiscordIdSchema.optional(),
    activities: z
      .object({
        clientSecret: registerSensitiveConfigSchema(z.string().min(1).optional()),
        applicationId: DiscordSnowflakeStringSchema.optional(),
      })
      .strict()
      .optional(),
    proxy: z.string().optional(),
    allowBots: buildChannelAllowBotsSchema({ allowMentions: true }),
    botLoopProtection: ChannelBotLoopProtectionSchema.optional(),
    dangerouslyAllowNameMatching: ChannelDangerouslyAllowNameMatchingSchema,
    mentionAliases: z.record(z.string(), DiscordSnowflakeStringSchema).optional(),
    suppressEmbeds: z.boolean().optional(),
    maxLinesPerMessage: z.number().int().positive().optional(),
    actions: z
      .object({
        reactions: z.boolean().optional(),
        stickers: z.boolean().optional(),
        emojiUploads: z.boolean().optional(),
        stickerUploads: z.boolean().optional(),
        polls: z.boolean().optional(),
        permissions: z.boolean().optional(),
        messages: z.boolean().optional(),
        threads: z.boolean().optional(),
        pins: z.boolean().optional(),
        search: z.boolean().optional(),
        memberInfo: z.boolean().optional(),
        roleInfo: z.boolean().optional(),
        roles: z.boolean().optional(),
        channelInfo: z.boolean().optional(),
        voiceStatus: z.boolean().optional(),
        events: z.boolean().optional(),
        moderation: z.boolean().optional(),
        channels: z.boolean().optional(),
        presence: z.boolean().optional(),
      })
      .strict()
      .optional(),
    thread: DiscordThreadSchema.optional(),
    dm: DiscordDmSchema.optional(),
    guilds: z.record(z.string(), DiscordGuildSchema.optional()).optional(),
    execApprovals: buildChannelExecApprovalsSchema(DiscordIdSchema, {
      cleanupAfterResolve: z.boolean().optional(),
    }),
    agentComponents: z
      .object({
        enabled: z.boolean().optional(),
        ttlMs: z
          .number()
          .int()
          .positive()
          .max(24 * 60 * 60 * 1000)
          .optional(),
      })
      .strict()
      .optional(),
    slashCommand: z
      .object({
        ephemeral: z.boolean().optional(),
      })
      .strict()
      .optional(),
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
    intents: z
      .object({
        presence: z.boolean().optional(),
        guildMembers: z.boolean().optional(),
        voiceStates: z.boolean().optional(),
      })
      .strict()
      .optional(),
    voice: DiscordVoiceSchema,
    pluralkit: z
      .object({
        enabled: z.boolean().optional(),
        token: registerSensitiveConfigSchema(SecretInputSchema.optional()),
      })
      .strict()
      .optional(),
    ...buildChannelReactionShape({ ackReaction: z.string().optional() }),
    ackReactionScope: z
      .enum(["group-mentions", "group-all", "direct", "all", "off", "none"])
      .optional(),
    activity: z.string().optional(),
    status: z.enum(["online", "dnd", "idle", "invisible"]).optional(),
    autoPresence: z
      .object({
        enabled: z.boolean().optional(),
        intervalMs: z.number().int().positive().optional(),
        minUpdateIntervalMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    activityType: z
      .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
      .optional(),
    activityUrl: z.string().url().optional(),
    inboundWorker: z
      .object({
        runTimeoutMs: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const activityText = normalizeOptionalString(value.activity) ?? "";
    const hasActivity = Boolean(activityText);
    const hasActivityType = value.activityType !== undefined;
    const activityUrl = normalizeOptionalString(value.activityUrl) ?? "";
    const hasActivityUrl = Boolean(activityUrl);

    if ((hasActivityType || hasActivityUrl) && !hasActivity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "channels.discord.activity is required when activityType or activityUrl is set",
        path: ["activity"],
      });
    }

    if (value.activityType === 1 && !hasActivityUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "channels.discord.activityUrl is required when activityType is 1 (Streaming)",
        path: ["activityUrl"],
      });
    }

    if (hasActivityUrl && value.activityType !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "channels.discord.activityType must be 1 (Streaming) when activityUrl is set",
        path: ["activityType"],
      });
    }

    const autoPresenceInterval = value.autoPresence?.intervalMs;
    const autoPresenceMinUpdate = value.autoPresence?.minUpdateIntervalMs;
    if (
      typeof autoPresenceInterval === "number" &&
      typeof autoPresenceMinUpdate === "number" &&
      autoPresenceMinUpdate > autoPresenceInterval
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "channels.discord.autoPresence.minUpdateIntervalMs must be less than or equal to channels.discord.autoPresence.intervalMs",
        path: ["autoPresence", "minUpdateIntervalMs"],
      });
    }

    // DM allowlist validation is enforced at DiscordConfigSchema so account entries
    // can inherit top-level allowFrom via runtime shallow merge.
  });

export const DiscordConfigSchema = DiscordAccountSchema.extend({
  accounts: z.record(z.string(), DiscordAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  const dmPolicy = value.dmPolicy ?? "pairing";
  const allowFrom = value.allowFrom;
  requireOpenAllowFrom({
    policy: dmPolicy,
    allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.discord.dmPolicy="open" requires channels.discord.allowFrom to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: dmPolicy,
    allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.discord.dmPolicy="allowlist" requires channels.discord.allowFrom to contain at least one sender ID',
  });

  if (!value.accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    const effectivePolicy = account.dmPolicy ?? value.dmPolicy ?? "pairing";
    const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
    requireOpenAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.discord.accounts.*.dmPolicy="open" requires channels.discord.accounts.*.allowFrom (or channels.discord.allowFrom) to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.discord.accounts.*.dmPolicy="allowlist" requires channels.discord.accounts.*.allowFrom (or channels.discord.allowFrom) to contain at least one sender ID',
    });
  }
});

export const DiscordChannelConfigSchema = buildChannelConfigSchema(DiscordConfigSchema, {
  uiHints: discordChannelConfigUiHints,
});
