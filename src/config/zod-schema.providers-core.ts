// Defines core provider schema fragments for config parsing.
import { isValidInboundPathRootPattern } from "@openclaw/media-core/inbound-path-policy";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import { buildGroupEntrySchema } from "../channels/plugins/config-schema.js";
import { isSafeScpRemoteHost } from "../infra/scp-host.js";
import {
  normalizeCommandDescription,
  normalizeSlashCommandName,
  resolveCustomCommands,
} from "../shared/custom-command-config.js";
import { hasConfiguredSecretInput } from "./types.secrets.js";
import { ToolPolicySchema } from "./zod-schema.agent-runtime.js";
import {
  ChannelBotLoopProtectionSchema,
  ChannelDangerouslyAllowNameMatchingSchema,
  ChannelSendReadReceiptsSchema,
  buildChannelAllowBotsSchema,
  buildChannelExecApprovalsSchema,
  buildChannelReactionShape,
  buildCommonChannelAccountShape,
} from "./zod-schema.channel-messaging-common.js";
import {
  BlockStreamingChunkSchema,
  ChannelDeliveryStreamingConfigSchema,
  ChannelStreamingBlockSchema,
  DmPolicySchema,
  ExecutableTokenSchema,
  GroupPolicySchema,
  HexColorSchema,
  MSTeamsReplyStyleSchema,
  ProviderCommandsSchema,
  SecretInputSchema,
  ReplyToModeSchema,
  TextChunkModeSchema,
  TtsConfigSchema,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "./zod-schema.core.js";
import {
  DiscordDmSchema,
  DiscordIdSchema,
  DiscordIdListSchema,
  DiscordPresenceEventsSchema,
  DiscordSnowflakeStringSchema,
} from "./zod-schema.discord.js";
import { ChannelImplicitMentionsSchema } from "./zod-schema.implicit-mentions.js";
import {
  validateSlackSigningSecretRequirements,
  validateTelegramWebhookSecretRequirements,
} from "./zod-schema.secret-input-validation.js";
import { sensitive } from "./zod-schema.sensitive.js";

const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const TelegramInlineButtonsScopeSchema = z.enum(["off", "dm", "group", "all", "allowlist"]);
const TelegramCapabilitiesSchema = z.union([
  z.array(z.string()),
  z
    .object({
      inlineButtons: TelegramInlineButtonsScopeSchema.optional(),
    })
    .strict(),
]);
const UnifiedStreamingModeSchema = z.enum(["off", "partial", "block", "progress"]);
const ChannelStreamingPreviewSchema = z
  .object({
    chunk: BlockStreamingChunkSchema.optional(),
    toolProgress: z.boolean().optional(),
    commandText: z.enum(["raw", "status"]).optional(),
  })
  .strict();
const ChannelStreamingProgressSchema = z
  .object({
    label: z.union([z.string(), z.literal(false)]).optional(),
    labels: z.array(z.string()).optional(),
    maxLines: z.number().int().positive().optional(),
    maxLineChars: z.number().int().positive().optional(),
    render: z.enum(["text", "rich"]).optional(),
    toolProgress: z.boolean().optional(),
    commandText: z.enum(["raw", "status"]).optional(),
    commentary: z.boolean().optional(),
    narration: z.boolean().optional(),
  })
  .strict();
const DiscordStreamingProgressSchema = ChannelStreamingProgressSchema;
const SlackStreamingProgressSchema = ChannelStreamingProgressSchema.extend({
  nativeTaskCards: z.boolean().optional(),
}).strict();

const ChannelPreviewStreamingConfigSchema = z
  .object({
    mode: UnifiedStreamingModeSchema.optional(),
    chunkMode: TextChunkModeSchema.optional(),
    preview: ChannelStreamingPreviewSchema.optional(),
    progress: ChannelStreamingProgressSchema.optional(),
    block: ChannelStreamingBlockSchema.optional(),
  })
  .strict();
const TelegramPreviewStreamingConfigSchema = ChannelPreviewStreamingConfigSchema.extend({
  preview: ChannelStreamingPreviewSchema.optional(),
}).strict();
const DiscordPreviewStreamingConfigSchema = ChannelPreviewStreamingConfigSchema.extend({
  progress: DiscordStreamingProgressSchema.optional(),
}).strict();
const SlackStreamingConfigSchema = ChannelPreviewStreamingConfigSchema.extend({
  nativeTransport: z.boolean().optional(),
  progress: SlackStreamingProgressSchema.optional(),
}).strict();
const SlackCapabilitiesSchema = z.union([
  z.array(z.string()),
  z
    .object({
      interactiveReplies: z.boolean().optional(),
    })
    .strict(),
]);
const TelegramErrorPolicySchema = z.enum(["always", "once", "silent"]).optional();
const TelegramCommandNamePattern = /^[a-z0-9_]{1,32}$/;
const TelegramCustomCommandConfig = {
  label: "Telegram",
  pattern: TelegramCommandNamePattern,
  patternDescription: "use a-z, 0-9, underscore; max 32 chars",
} as const;
const TelegramTopicSchema = z
  .object({
    requireMention: z.boolean().optional(),
    ingest: z.boolean().optional(),
    disableAudioPreflight: z.boolean().optional(),
    groupPolicy: GroupPolicySchema.optional(),
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
    agentId: z.string().optional(),
    errorPolicy: TelegramErrorPolicySchema,
  })
  .strict();

const TelegramGroupSchema = buildGroupEntrySchema({
  ingest: z.boolean().optional(),
  disableAudioPreflight: z.boolean().optional(),
  groupPolicy: GroupPolicySchema.optional(),
  topics: z.record(z.string(), TelegramTopicSchema.optional()).optional(),
  errorPolicy: TelegramErrorPolicySchema,
});

const AutoTopicLabelSchema = z
  .union([
    z.boolean(),
    z
      .object({
        enabled: z.boolean().optional(),
        prompt: z.string().optional(),
      })
      .strict(),
  ])
  .optional();

const TelegramDirectSchema = z
  .object({
    dmPolicy: DmPolicySchema.optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
    topics: z.record(z.string(), TelegramTopicSchema.optional()).optional(),
    errorPolicy: TelegramErrorPolicySchema,
    requireTopic: z.boolean().optional(),
    autoTopicLabel: AutoTopicLabelSchema,
  })
  .strict();

const TelegramCustomCommandSchema = z
  .object({
    command: z.string().overwrite(normalizeSlashCommandName),
    description: z.string().overwrite(normalizeCommandDescription),
  })
  .strict();

const validateTelegramCustomCommands = (
  value: { customCommands?: Array<{ command?: string; description?: string }> },
  ctx: z.RefinementCtx,
) => {
  if (!value.customCommands || value.customCommands.length === 0) {
    return;
  }
  const { issues } = resolveCustomCommands({
    commands: value.customCommands,
    checkReserved: false,
    checkDuplicates: false,
    config: TelegramCustomCommandConfig,
  });
  for (const issue of issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["customCommands", issue.index, issue.field],
      message: issue.message,
    });
  }
};

const TelegramAccountSchemaBase = z
  .object({
    ...buildCommonChannelAccountShape({
      useDefaults: true,
      capabilities: TelegramCapabilitiesSchema.optional(),
      defaultTo: z.union([z.string(), z.number()]).optional(),
      streaming: TelegramPreviewStreamingConfigSchema.optional(),
    }),
    execApprovals: buildChannelExecApprovalsSchema(z.union([z.string(), z.number()])),
    commands: ProviderCommandsSchema,
    customCommands: z.array(TelegramCustomCommandSchema).optional(),
    botToken: SecretInputSchema.optional().register(sensitive),
    tokenFile: z.string().optional(),
    groups: z.record(z.string(), TelegramGroupSchema.optional()).optional(),
    direct: z.record(z.string(), TelegramDirectSchema.optional()).optional(),
    richMessages: z.boolean().optional(),
    network: z
      .object({
        autoSelectFamily: z.boolean().optional(),
        dnsResultOrder: z.enum(["ipv4first", "verbatim"]).optional(),
        dangerouslyAllowPrivateNetwork: z
          .boolean()
          .optional()
          .describe(
            "Dangerous opt-in for trusted Telegram fake-IP or transparent-proxy environments where api.telegram.org resolves to private/internal/special-use addresses during media downloads.",
          ),
      })
      .strict()
      .optional(),
    proxy: z.string().optional(),
    webhookUrl: z
      .string()
      .optional()
      .describe(
        "Public HTTPS webhook URL registered with Telegram for inbound updates. This must be internet-reachable and requires channels.telegram.webhookSecret.",
      ),
    webhookSecret: SecretInputSchema.optional()
      .describe(
        "Secret token sent to Telegram during webhook registration and verified on inbound webhook requests. Telegram returns this value for verification; this is not the gateway auth token and not the bot token.",
      )
      .register(sensitive),
    webhookPath: z
      .string()
      .optional()
      .describe(
        "Local webhook route path served by the gateway listener. Defaults to /telegram-webhook.",
      ),
    webhookHost: z
      .string()
      .optional()
      .describe(
        "Local bind host for the webhook listener. Defaults to 127.0.0.1; keep loopback unless you intentionally expose direct ingress.",
      ),
    webhookPort: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Local bind port for the webhook listener. Defaults to 8787; set to 0 to let the OS assign an ephemeral port.",
      ),
    webhookCertPath: z
      .string()
      .optional()
      .describe(
        "Path to the self-signed certificate (PEM) to upload to Telegram during webhook registration. Required for self-signed certs (direct IP or no domain).",
      ),
    actions: z
      .object({
        reactions: z.boolean().optional(),
        sendMessage: z.boolean().optional(),
        poll: z.boolean().optional(),
        deleteMessage: z.boolean().optional(),
        editMessage: z.boolean().optional(),
        sticker: z.boolean().optional(),
        createForumTopic: z.boolean().optional(),
        editForumTopic: z.boolean().optional(),
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
    ...buildChannelReactionShape({
      notificationModes: ["off", "own", "all"],
      reactionLevels: ["off", "ack", "minimal", "extensive"],
      ackReaction: z.string().optional(),
    }),
    linkPreview: z.boolean().optional(),
    silentErrorReplies: z.boolean().optional(),
    errorPolicy: TelegramErrorPolicySchema,
    apiRoot: z.string().url().optional(),
    trustedLocalFileRoots: z
      .array(z.string())
      .optional()
      .describe(
        "Trusted local filesystem roots for self-hosted Telegram Bot API absolute file_path values. Only absolute paths under these roots are read directly; all other absolute paths are rejected.",
      ),
    autoTopicLabel: AutoTopicLabelSchema,
  })
  .strict();

const TelegramAccountSchema = TelegramAccountSchemaBase.superRefine((value, ctx) => {
  // Account-level schemas skip allowFrom validation because accounts inherit
  // allowFrom from the parent channel config at runtime (resolveTelegramAccount
  // shallow-merges top-level and account values in src/telegram/accounts.ts).
  // Validation is enforced at the top-level TelegramConfigSchema instead.
  validateTelegramCustomCommands(value, ctx);
});

export const TelegramConfigSchema = TelegramAccountSchemaBase.extend({
  accounts: z.record(z.string(), TelegramAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.telegram.dmPolicy="open" requires channels.telegram.allowFrom to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.telegram.dmPolicy="allowlist" requires channels.telegram.allowFrom to contain at least one sender ID',
  });
  validateTelegramCustomCommands(value, ctx);

  if (value.accounts) {
    for (const [accountId, account] of Object.entries(value.accounts)) {
      if (!account) {
        continue;
      }
      const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
      const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
      requireOpenAllowFrom({
        policy: effectivePolicy,
        allowFrom: effectiveAllowFrom,
        ctx,
        path: ["accounts", accountId, "allowFrom"],
        message:
          'channels.telegram.accounts.*.dmPolicy="open" requires channels.telegram.accounts.*.allowFrom (or channels.telegram.allowFrom) to include "*"',
      });
      requireAllowlistAllowFrom({
        policy: effectivePolicy,
        allowFrom: effectiveAllowFrom,
        ctx,
        path: ["accounts", accountId, "allowFrom"],
        message:
          'channels.telegram.accounts.*.dmPolicy="allowlist" requires channels.telegram.accounts.*.allowFrom (or channels.telegram.allowFrom) to contain at least one sender ID',
      });
    }
  }

  if (!value.accounts) {
    validateTelegramWebhookSecretRequirements(value, ctx);
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    if (account.enabled === false) {
      continue;
    }
    const effectiveDmPolicy = account.dmPolicy ?? value.dmPolicy;
    const effectiveAllowFrom = Array.isArray(account.allowFrom)
      ? account.allowFrom
      : value.allowFrom;
    requireOpenAllowFrom({
      policy: effectiveDmPolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.telegram.accounts.*.dmPolicy="open" requires channels.telegram.allowFrom or channels.telegram.accounts.*.allowFrom to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectiveDmPolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.telegram.accounts.*.dmPolicy="allowlist" requires channels.telegram.allowFrom or channels.telegram.accounts.*.allowFrom to contain at least one sender ID',
    });
  }
  validateTelegramWebhookSecretRequirements(value, ctx);
});

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

const DiscordUiSchema = z
  .object({
    components: z
      .object({
        accentColor: HexColorSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

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
    token: SecretInputSchema.optional().register(sensitive),
    applicationId: DiscordIdSchema.optional(),
    activities: z
      .object({
        clientSecret: z.string().min(1).optional().register(sensitive),
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
    ui: DiscordUiSchema,
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
    subagentProgress: z.boolean().optional(),
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
        token: SecretInputSchema.optional().register(sensitive),
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
        healthyText: z.string().optional(),
        degradedText: z.string().optional(),
        exhaustedText: z.string().optional(),
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

const SlackDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    groupEnabled: z.boolean().optional(),
    groupChannels: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict();

const SlackPresenceEventsSchema = z
  .object({
    mode: z.enum(["off", "auto", "on"]).optional(),
  })
  .strict();

const SlackChannelSchema = buildGroupEntrySchema(
  {
    ignoreOtherMentions: z.boolean().optional(),
    replyToMode: ReplyToModeSchema.optional(),
    allowBots: buildChannelAllowBotsSchema({ allowMentions: true }),
    botLoopProtection: ChannelBotLoopProtectionSchema.optional(),
    users: z.array(z.union([z.string(), z.number()])).optional(),
    presenceEvents: SlackPresenceEventsSchema.optional(),
  },
  { omit: ["allowFrom"] },
);

const SlackThreadSchema = z
  .object({
    historyScope: z.enum(["thread", "channel"]).optional(),
    inheritParent: z.boolean().optional(),
    initialHistoryLimit: z.number().int().min(0).optional(),
  })
  .strict();

const ReplyToModeByChatTypeSchema = z
  .object({
    direct: ReplyToModeSchema.optional(),
    group: ReplyToModeSchema.optional(),
    channel: ReplyToModeSchema.optional(),
  })
  .strict();

const DirectGroupReplyToModeByChatTypeSchema = z
  .object({
    direct: ReplyToModeSchema.optional(),
    group: ReplyToModeSchema.optional(),
  })
  .strict();

const SlackSocketModeSchema = z
  .object({
    clientPingTimeout: z.number().int().positive().optional(),
    serverPingTimeout: z.number().int().positive().optional(),
    pingPongLoggingEnabled: z.boolean().optional(),
  })
  .strict();

const SlackRelaySchema = z
  .object({
    url: z.string().optional(),
    authToken: SecretInputSchema.optional().register(sensitive),
    gatewayId: z.string().optional(),
  })
  .strict();

const SlackIdentitySchema = z.enum(["bot", "user"]);

const SlackAccountSchema = z
  .object({
    ...buildCommonChannelAccountShape({
      omit: ["groupAllowFrom"],
      capabilities: SlackCapabilitiesSchema.optional(),
      streaming: SlackStreamingConfigSchema.optional(),
    }),
    identity: SlackIdentitySchema.default("bot"),
    mode: z.enum(["socket", "http", "relay"]).optional(),
    enterpriseOrgInstall: z.boolean().optional(),
    socketMode: SlackSocketModeSchema.optional(),
    relay: SlackRelaySchema.optional(),
    signingSecret: SecretInputSchema.optional().register(sensitive),
    webhookPath: z.string().optional(),
    execApprovals: buildChannelExecApprovalsSchema(z.union([z.string(), z.number()])),
    commands: ProviderCommandsSchema,
    botToken: SecretInputSchema.optional().register(sensitive),
    appToken: SecretInputSchema.optional().register(sensitive),
    userToken: SecretInputSchema.optional().register(sensitive),
    userTokenReadOnly: z.boolean().optional().default(true),
    allowBots: buildChannelAllowBotsSchema({ allowMentions: true }),
    botLoopProtection: ChannelBotLoopProtectionSchema.optional(),
    dangerouslyAllowNameMatching: ChannelDangerouslyAllowNameMatchingSchema,
    requireMention: z.boolean().optional(),
    implicitMentions: ChannelImplicitMentionsSchema.optional(),
    unfurlLinks: z.boolean().optional(),
    unfurlMedia: z.boolean().optional(),
    ...buildChannelReactionShape({
      notificationModes: ["off", "own", "all", "allowlist"],
      reactionAllowlist: true,
      ackReaction: z.string().optional(),
    }),
    replyToModeByChatType: ReplyToModeByChatTypeSchema.optional(),
    thread: SlackThreadSchema.optional(),
    presenceEvents: SlackPresenceEventsSchema.optional(),
    actions: z
      .object({
        reactions: z.boolean().optional(),
        messages: z.boolean().optional(),
        pins: z.boolean().optional(),
        search: z.boolean().optional(),
        permissions: z.boolean().optional(),
        memberInfo: z.boolean().optional(),
        channelInfo: z.boolean().optional(),
        emojiList: z.boolean().optional(),
      })
      .strict()
      .optional(),
    slashCommand: z
      .object({
        enabled: z.boolean().optional(),
        name: z.string().optional(),
        sessionPrefix: z.string().optional(),
        ephemeral: z.boolean().optional(),
      })
      .strict()
      .optional(),
    dm: SlackDmSchema.optional(),
    channels: z.record(z.string(), SlackChannelSchema.optional()).optional(),
    typingReaction: z.string().optional(),
  })
  .strict();

// Account entries leave identity unset to inherit the top-level default. DM allowlist
// validation stays at SlackConfigSchema so entries can also inherit top-level allowFrom.
const SlackAccountEntrySchema = SlackAccountSchema.extend({
  identity: SlackIdentitySchema.optional(),
});

export const SlackConfigSchema = SlackAccountSchema.safeExtend({
  mode: z.enum(["socket", "http", "relay"]).optional().default("socket"),
  signingSecret: SecretInputSchema.optional().register(sensitive),
  webhookPath: z.string().optional().default("/slack/events"),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  accounts: z.record(z.string(), SlackAccountEntrySchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  const dmPolicy = value.dmPolicy ?? "pairing";
  const allowFrom = value.allowFrom;
  requireOpenAllowFrom({
    policy: dmPolicy,
    allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.slack.dmPolicy="open" requires channels.slack.allowFrom to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: dmPolicy,
    allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.slack.dmPolicy="allowlist" requires channels.slack.allowFrom to contain at least one sender ID',
  });

  const requireRelayConfig = (
    relay: { url?: unknown; authToken?: unknown; gatewayId?: unknown } | undefined,
    path: (string | number)[],
  ) => {
    if (typeof relay?.url !== "string" || !relay.url.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'channels.slack.mode="relay" requires relay.url',
        path: [...path, "url"],
      });
    }
    if (!hasConfiguredSecretInput(relay?.authToken)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'channels.slack.mode="relay" requires relay.authToken',
        path: [...path, "authToken"],
      });
    }
    if (typeof relay?.gatewayId !== "string" || !relay.gatewayId.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'channels.slack.mode="relay" requires relay.gatewayId',
        path: [...path, "gatewayId"],
      });
    }
  };

  const baseMode = value.mode ?? "socket";
  const accountIds = value.accounts ? Object.keys(value.accounts) : [];
  if (!value.accounts) {
    if (baseMode === "relay") {
      requireRelayConfig(value.relay, ["relay"]);
    }
    validateSlackSigningSecretRequirements(value, ctx);
    return;
  }
  for (const accountId of accountIds) {
    const account = value.accounts[accountId];
    if (!account) {
      continue;
    }
    if (account.enabled === false) {
      continue;
    }
    const accountMode = account.mode ?? baseMode;
    const effectiveRelay = {
      ...value.relay,
      ...account.relay,
    };
    const effectivePolicy = account.dmPolicy ?? value.dmPolicy ?? "pairing";
    const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
    requireOpenAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.slack.accounts.*.dmPolicy="open" requires channels.slack.accounts.*.allowFrom (or channels.slack.allowFrom) to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.slack.accounts.*.dmPolicy="allowlist" requires channels.slack.accounts.*.allowFrom (or channels.slack.allowFrom) to contain at least one sender ID',
    });
    if (accountMode !== "http") {
      if (accountMode === "relay") {
        requireRelayConfig(effectiveRelay, ["accounts", accountId, "relay"]);
      }
      continue;
    }
  }
  validateSlackSigningSecretRequirements(value, ctx);
});

const SignalGroupEntrySchema = buildGroupEntrySchema(
  {
    ingest: z.boolean().optional(),
  },
  { omit: ["skills", "enabled", "allowFrom", "systemPrompt"] },
);

const SignalGroupsSchema = z.record(z.string(), SignalGroupEntrySchema.optional()).optional();

const SignalAccountSchemaBase = z
  .object({
    ...buildCommonChannelAccountShape({
      useDefaults: true,
      omit: ["mentionPatterns"],
      streaming: ChannelDeliveryStreamingConfigSchema.optional(),
      mediaMaxMb: z.number().int().positive().optional(),
    }),
    account: z.string().optional(),
    accountUuid: z.string().optional(),
    configPath: z.string().optional(),
    httpUrl: z.string().optional(),
    httpHost: z.string().optional(),
    httpPort: z.number().int().positive().optional(),
    cliPath: ExecutableTokenSchema.optional(),
    autoStart: z.boolean().optional(),
    startupTimeoutMs: z.number().int().min(1000).max(120000).optional(),
    receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
    ignoreAttachments: z.boolean().optional(),
    ignoreStories: z.boolean().optional(),
    sendReadReceipts: ChannelSendReadReceiptsSchema,
    aliases: z.record(z.string(), z.string()).optional(),
    groups: SignalGroupsSchema,
    replyToModeByChatType: DirectGroupReplyToModeByChatTypeSchema.optional(),
    ...buildChannelReactionShape({
      notificationModes: ["off", "own", "all", "allowlist"],
      reactionAllowlist: true,
      reactionLevels: ["off", "ack", "minimal", "extensive"],
    }),
    actions: z
      .object({
        reactions: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const SignalConfigSchema = SignalAccountSchemaBase.extend({
  apiMode: z.enum(["auto", "native", "container"]).optional(),
  // Account-level schemas skip allowFrom validation because accounts inherit
  // allowFrom from the parent channel config at runtime.
  accounts: z.record(z.string(), SignalAccountSchemaBase.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.signal.dmPolicy="open" requires channels.signal.allowFrom to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.signal.dmPolicy="allowlist" requires channels.signal.allowFrom to contain at least one sender ID',
  });

  if (!value.accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
    const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
    requireOpenAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.signal.accounts.*.dmPolicy="open" requires channels.signal.accounts.*.allowFrom (or channels.signal.allowFrom) to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.signal.accounts.*.dmPolicy="allowlist" requires channels.signal.accounts.*.allowFrom (or channels.signal.allowFrom) to contain at least one sender ID',
    });
  }
});
const IMessageActionSchema = z
  .object({
    reactions: z.boolean().optional(),
    edit: z.boolean().optional(),
    unsend: z.boolean().optional(),
    reply: z.boolean().optional(),
    sendWithEffect: z.boolean().optional(),
    renameGroup: z.boolean().optional(),
    setGroupIcon: z.boolean().optional(),
    addParticipant: z.boolean().optional(),
    removeParticipant: z.boolean().optional(),
    leaveGroup: z.boolean().optional(),
    sendAttachment: z.boolean().optional(),
    polls: z.boolean().optional(),
  })
  .strict()
  .optional();

const IMessageAccountSchemaBase = z
  .object({
    ...buildCommonChannelAccountShape({
      useDefaults: true,
      omit: ["mentionPatterns", "replyToMode"],
      streaming: ChannelDeliveryStreamingConfigSchema.optional(),
      mediaMaxMb: z.number().int().positive().optional(),
    }),
    cliPath: ExecutableTokenSchema.optional(),
    dbPath: z.string().optional(),
    remoteHost: z
      .string()
      .refine(isSafeScpRemoteHost, "expected SSH host or user@host (no spaces/options)")
      .optional(),
    actions: IMessageActionSchema,
    service: z.union([z.literal("imessage"), z.literal("sms"), z.literal("auto")]).optional(),
    sendTransport: z.enum(["auto", "bridge", "applescript"]).optional(),
    region: z.string().optional(),
    includeAttachments: z.boolean().optional(),
    attachmentRoots: z
      .array(z.string().refine(isValidInboundPathRootPattern, "expected absolute path root"))
      .optional(),
    remoteAttachmentRoots: z
      .array(z.string().refine(isValidInboundPathRootPattern, "expected absolute path root"))
      .optional(),
    probeTimeoutMs: z.number().int().positive().optional(),
    sendReadReceipts: ChannelSendReadReceiptsSchema,
    ...buildChannelReactionShape({ notificationModes: ["off", "own", "all"] }),
    coalesceSameSenderDms: z.boolean().optional(),
    catchup: z
      .object({
        enabled: z.boolean().optional(),
        maxAgeMinutes: z.number().int().min(1).max(720).optional(),
        perRunLimit: z.number().int().min(1).max(500).optional(),
        firstRunLookbackMinutes: z.number().int().min(1).max(720).optional(),
        maxFailureRetries: z.number().int().min(1).max(1000).optional(),
      })
      .strict()
      .optional(),
    groups: z
      .record(
        z.string(),
        buildGroupEntrySchema(undefined, {
          omit: ["skills", "enabled", "allowFrom"],
        }).optional(),
      )
      .optional(),
  })
  .strict();

export const IMessageConfigSchema = IMessageAccountSchemaBase.extend({
  // Account-level schemas skip allowFrom validation because accounts inherit
  // allowFrom from the parent channel config at runtime.
  accounts: z.record(z.string(), IMessageAccountSchemaBase.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.imessage.dmPolicy="open" requires channels.imessage.allowFrom to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.imessage.dmPolicy="allowlist" requires channels.imessage.allowFrom to contain at least one sender ID',
  });

  if (!value.accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
    const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
    requireOpenAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.imessage.accounts.*.dmPolicy="open" requires channels.imessage.accounts.*.allowFrom (or channels.imessage.allowFrom) to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.imessage.accounts.*.dmPolicy="allowlist" requires channels.imessage.accounts.*.allowFrom (or channels.imessage.allowFrom) to contain at least one sender ID',
    });
  }
});

const MSTeamsChannelSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    replyStyle: MSTeamsReplyStyleSchema.optional(),
  })
  .strict();

const MSTeamsTeamSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    replyStyle: MSTeamsReplyStyleSchema.optional(),
    channels: z.record(z.string(), MSTeamsChannelSchema.optional()).optional(),
  })
  .strict();

const MSTEAMS_SERVICE_URL_HOST_ALLOWLIST = [
  "smba.trafficmanager.net",
  "smba.infra.gcc.teams.microsoft.com",
  "smba.infra.gov.teams.microsoft.us",
  "smba.infra.dod.teams.microsoft.us",
  "botframework.azure.cn",
] as const;

function isAllowedMSTeamsServiceUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return MSTEAMS_SERVICE_URL_HOST_ALLOWLIST.some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`),
    );
  } catch {
    return false;
  }
}

function isAzureChinaBotFrameworkServiceUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return host === "botframework.azure.cn" || host.endsWith(".botframework.azure.cn");
  } catch {
    return false;
  }
}

export const MSTeamsConfigSchema = z
  .object({
    ...buildCommonChannelAccountShape({
      useDefaults: true,
      omit: ["name", "mentionPatterns", "replyToMode"],
      allowFrom: z.array(z.string()).optional(),
      groupAllowFrom: z.array(z.string()).optional(),
      streaming: ChannelPreviewStreamingConfigSchema.optional(),
    }),
    dangerouslyAllowNameMatching: ChannelDangerouslyAllowNameMatchingSchema,
    appId: z.string().optional(),
    appPassword: SecretInputSchema.optional().register(sensitive),
    tenantId: z.string().optional(),
    cloud: z.enum(["Public", "USGov", "USGovDoD", "China"]).optional(),
    serviceUrl: z
      .string()
      .url()
      .refine(isAllowedMSTeamsServiceUrl, {
        message:
          "channels.msteams.serviceUrl must use a supported Microsoft Teams Bot Connector host",
      })
      .optional(),
    authType: z.enum(["secret", "federated"]).optional(),
    certificatePath: z.string().optional(),
    certificateThumbprint: z.string().optional(),
    useManagedIdentity: z.boolean().optional(),
    managedIdentityClientId: z.string().optional(),
    webhook: z
      .object({
        port: z.number().int().positive().optional(),
        path: z.string().optional(),
      })
      .strict()
      .optional(),
    typingIndicator: z.boolean().optional(),
    mediaAllowHosts: z.array(z.string()).optional(),
    mediaAuthAllowHosts: z.array(z.string()).optional(),
    graphMediaFallback: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    replyStyle: MSTeamsReplyStyleSchema.optional(),
    teams: z.record(z.string(), MSTeamsTeamSchema.optional()).optional(),
    /** Max inbound and outbound media size in MB (default: 100MB). */
    /** SharePoint site ID for file uploads in group chats/channels (e.g., "contoso.sharepoint.com,guid1,guid2") */
    sharePointSiteId: z.string().optional(),
    welcomeCard: z.boolean().optional(),
    promptStarters: z.array(z.string()).optional(),
    groupWelcomeCard: z.boolean().optional(),
    feedbackEnabled: z.boolean().optional(),
    feedbackReflection: z.boolean().optional(),
    feedbackReflectionCooldownMs: z.number().int().min(0).optional(),
    delegatedAuth: z
      .object({
        enabled: z.boolean().optional(),
        scopes: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    sso: z
      .object({
        enabled: z.boolean().optional(),
        connectionName: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireOpenAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.msteams.dmPolicy="open" requires channels.msteams.allowFrom to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.msteams.dmPolicy="allowlist" requires channels.msteams.allowFrom to contain at least one sender ID',
    });
    if (value.sso?.enabled === true && !value.sso.connectionName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sso", "connectionName"],
        message:
          "channels.msteams.sso.enabled=true requires channels.msteams.sso.connectionName to identify the Bot Framework OAuth connection",
      });
    }
    if (
      value.cloud &&
      value.cloud !== "Public" &&
      value.cloud !== "China" &&
      !value.serviceUrl?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serviceUrl"],
        message:
          "channels.msteams.cloud requires channels.msteams.serviceUrl for non-public Teams clouds",
      });
    }
    if (
      value.cloud === "China" &&
      value.serviceUrl?.trim() &&
      !isAzureChinaBotFrameworkServiceUrl(value.serviceUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serviceUrl"],
        message:
          "channels.msteams.cloud=China requires channels.msteams.serviceUrl to use an Azure China Bot Framework channel host",
      });
    }
    if (
      value.cloud !== "China" &&
      value.serviceUrl?.trim() &&
      isAzureChinaBotFrameworkServiceUrl(value.serviceUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cloud"],
        message: "Azure China Bot Framework serviceUrl hosts require channels.msteams.cloud=China",
      });
    }

    // Federated auth fields (appId, tenantId, certificatePath,
    // useManagedIdentity) may come from MSTEAMS_* environment variables,
    // so we cannot require them in the config object itself.
    // Runtime validation happens in resolveMSTeamsCredentials().
  });
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
