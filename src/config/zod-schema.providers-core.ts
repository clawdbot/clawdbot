import { z } from "zod";
import { isSafeScpRemoteHost } from "../infra/scp-host.js";
import { isValidInboundPathRootPattern } from "../media/inbound-path-policy.js";
import {
  normalizeCommandDescription,
  normalizeSlashCommandName,
  resolveCustomCommands,
} from "../shared/custom-command-config.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { ToolPolicySchema } from "./zod-schema.agent-runtime.js";
import {
  ChannelHealthMonitorSchema,
  ChannelHeartbeatVisibilitySchema,
} from "./zod-schema.channels.js";
import {
  BlockStreamingChunkSchema,
  BlockStreamingCoalesceSchema,
  ContextVisibilityModeSchema,
  DmConfigSchema,
  DmPolicySchema,
  ExecutableTokenSchema,
  GroupPolicySchema,
  HexColorSchema,
  MarkdownConfigSchema,
  MSTeamsReplyStyleSchema,
  ProviderCommandsSchema,
  SecretRefSchema,
  SecretInputSchema,
  ReplyToModeSchema,
  RetryConfigSchema,
  TtsConfigSchema,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "./zod-schema.core.js";
import {
  validateSlackSigningSecretRequirements,
  validateTelegramWebhookSecretRequirements,
} from "./zod-schema.secret-input-validation.js";
import { sensitive } from "./zod-schema.sensitive.js";

const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

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

const TelegramInlineButtonsScopeSchema = z.enum(["off", "dm", "group", "all", "allowlist"]);
const TelegramIdListSchema = z.array(z.union([z.string(), z.number()]));

const TelegramCapabilitiesSchema = z.union([
  z.array(z.string()),
  z
    .object({
      inlineButtons: TelegramInlineButtonsScopeSchema.optional(),
    })
    .strict(),
]);
const TextChunkModeSchema = z.enum(["length", "newline"]);
const UnifiedStreamingModeSchema = z.enum(["off", "partial", "block", "progress"]);
const ChannelStreamingBlockSchema = z
  .object({
    enabled: z.boolean().optional(),
    coalesce: BlockStreamingCoalesceSchema.optional(),
  })
  .strict();
const ChannelStreamingPreviewSchema = z
  .object({
    chunk: BlockStreamingChunkSchema.optional(),
    toolProgress: z.boolean().optional(),
  })
  .strict();
const ChannelPreviewStreamingConfigSchema = z
  .object({
    mode: UnifiedStreamingModeSchema.optional(),
    chunkMode: TextChunkModeSchema.optional(),
    preview: ChannelStreamingPreviewSchema.optional(),
    block: ChannelStreamingBlockSchema.optional(),
  })
  .strict();
const SlackStreamingConfigSchema = ChannelPreviewStreamingConfigSchema.extend({
  nativeTransport: z.boolean().optional(),
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
export const TelegramTopicSchema = z
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
    errorCooldownMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export const TelegramGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    ingest: z.boolean().optional(),
    disableAudioPreflight: z.boolean().optional(),
    groupPolicy: GroupPolicySchema.optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
    topics: z.record(z.string(), TelegramTopicSchema.optional()).optional(),
    errorPolicy: TelegramErrorPolicySchema,
    errorCooldownMs: z.number().int().nonnegative().optional(),
  })
  .strict();

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

export const TelegramDirectSchema = z
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
    errorCooldownMs: z.number().int().nonnegative().optional(),
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

export const TelegramAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: TelegramCapabilitiesSchema.optional(),
    execApprovals: z
      .object({
        enabled: z.boolean().optional(),
        approvers: TelegramIdListSchema.optional(),
        agentFilter: z.array(z.string()).optional(),
        sessionFilter: z.array(z.string()).optional(),
        target: z.enum(["dm", "channel", "both"]).optional(),
      })
      .strict()
      .optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    commands: ProviderCommandsSchema,
    customCommands: z.array(TelegramCustomCommandSchema).optional(),
    configWrites: z.boolean().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    botToken: SecretInputSchema.optional().register(sensitive),
    tokenFile: z.string().optional(),
    replyToMode: ReplyToModeSchema.optional(),
    groups: z.record(z.string(), TelegramGroupSchema.optional()).optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    defaultTo: z.union([z.string(), z.number()]).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    direct: z.record(z.string(), TelegramDirectSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    streaming: ChannelPreviewStreamingConfigSchema.optional(),
    mediaMaxMb: z.number().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    pollingStallThresholdMs: z.number().int().min(30_000).max(600_000).optional(),
    retry: RetryConfigSchema,
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
        spawnSubagentSessions: z.boolean().optional(),
        spawnAcpSessions: z.boolean().optional(),
      })
      .strict()
      .optional(),
    reactionNotifications: z.enum(["off", "own", "all"]).optional(),
    reactionLevel: z.enum(["off", "ack", "minimal", "extensive"]).optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    healthMonitor: ChannelHealthMonitorSchema,
    linkPreview: z.boolean().optional(),
    silentErrorReplies: z.boolean().optional(),
    responsePrefix: z.string().optional(),
    ackReaction: z.string().optional(),
    errorPolicy: TelegramErrorPolicySchema,
    errorCooldownMs: z.number().int().nonnegative().optional(),
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

export const TelegramAccountSchema = TelegramAccountSchemaBase.superRefine((value, ctx) => {
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

export const DiscordDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional(),
    allowFrom: DiscordIdListSchema.optional(),
    groupEnabled: z.boolean().optional(),
    groupChannels: DiscordIdListSchema.optional(),
  })
  .strict();

export const DiscordThreadSchema = z
  .object({
    inheritParent: z.boolean().optional(),
  })
  .strict();

export const DiscordGuildChannelSchema = z
  .object({
    requireMention: z.boolean().optional(),
    ignoreOtherMentions: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    users: DiscordIdListSchema.optional(),
    roles: DiscordIdListSchema.optional(),
    systemPrompt: z.string().optional(),
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
  })
  .strict();

export const DiscordGuildSchema = z
  .object({
    slug: z.string().optional(),
    requireMention: z.boolean().optional(),
    ignoreOtherMentions: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    reactionNotifications: z.enum(["off", "own", "all", "allowlist"]).optional(),
    users: DiscordIdListSchema.optional(),
    roles: DiscordIdListSchema.optional(),
    channels: z.record(z.string(), DiscordGuildChannelSchema.optional()).optional(),
  })
  .strict();

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

const DiscordVoiceSchema = z
  .object({
    enabled: z.boolean().optional(),
    model: z.string().min(1).optional(),
    autoJoin: z.array(DiscordVoiceAutoJoinSchema).optional(),
    daveEncryption: z.boolean().optional(),
    decryptionFailureTolerance: z.number().int().min(0).optional(),
    tts: TtsConfigSchema.optional(),
  })
  .strict()
  .optional();

export const DiscordAccountSchema = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    commands: ProviderCommandsSchema,
    configWrites: z.boolean().optional(),
    token: SecretInputSchema.optional().register(sensitive),
    proxy: z.string().optional(),
    allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
    dangerouslyAllowNameMatching: z.boolean().optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    streaming: ChannelPreviewStreamingConfigSchema.optional(),
    maxLinesPerMessage: z.number().int().positive().optional(),
    mediaMaxMb: z.number().positive().optional(),
    retry: RetryConfigSchema,
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
    replyToMode: ReplyToModeSchema.optional(),
    thread: DiscordThreadSchema.optional(),
    // Aliases for channels.discord.dm.policy / channels.discord.dm.allowFrom. Prefer these for
    // inheritance in multi-account setups (shallow merge works; nested dm object doesn't).
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: DiscordIdListSchema.optional(),
    defaultTo: z.string().optional(),
    dm: DiscordDmSchema.optional(),
    guilds: z.record(z.string(), DiscordGuildSchema.optional()).optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    healthMonitor: ChannelHealthMonitorSchema,
    execApprovals: z
      .object({
        enabled: z.boolean().optional(),
        approvers: DiscordIdListSchema.optional(),
        agentFilter: z.array(z.string()).optional(),
        sessionFilter: z.array(z.string()).optional(),
        cleanupAfterResolve: z.boolean().optional(),
        target: z.enum(["dm", "channel", "both"]).optional(),
      })
      .strict()
      .optional(),
    agentComponents: z
      .object({
        enabled: z.boolean().optional(),
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
        spawnSubagentSessions: z.boolean().optional(),
        spawnAcpSessions: z.boolean().optional(),
      })
      .strict()
      .optional(),
    intents: z
      .object({
        presence: z.boolean().optional(),
        guildMembers: z.boolean().optional(),
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
    responsePrefix: z.string().optional(),
    ackReaction: z.string().optional(),
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
    eventQueue: z
      .object({
        listenerTimeout: z.number().int().positive().optional(),
        maxQueueSize: z.number().int().positive().optional(),
        maxConcurrency: z.number().int().positive().optional(),
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
  const dmPolicy = value.dmPolicy ?? value.dm?.policy ?? "pairing";
  const allowFrom = value.allowFrom ?? value.dm?.allowFrom;
  const allowFromPath =
    value.allowFrom !== undefined ? (["allowFrom"] as const) : (["dm", "allowFrom"] as const);
  requireOpenAllowFrom({
    policy: dmPolicy,
    allowFrom,
    ctx,
    path: [...allowFromPath],
    message:
      'channels.discord.dmPolicy="open" requires channels.discord.allowFrom (or channels.discord.dm.allowFrom) to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: dmPolicy,
    allowFrom,
    ctx,
    path: [...allowFromPath],
    message:
      'channels.discord.dmPolicy="allowlist" requires channels.discord.allowFrom (or channels.discord.dm.allowFrom) to contain at least one sender ID',
  });

  if (!value.accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    const effectivePolicy =
      account.dmPolicy ?? account.dm?.policy ?? value.dmPolicy ?? value.dm?.policy ?? "pairing";
    const effectiveAllowFrom =
      account.allowFrom ?? account.dm?.allowFrom ?? value.allowFrom ?? value.dm?.allowFrom;
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

export const GoogleChatDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireOpenAllowFrom({
      policy: value.policy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.googlechat.dm.policy="open" requires channels.googlechat.dm.allowFrom to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: value.policy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.googlechat.dm.policy="allowlist" requires channels.googlechat.dm.allowFrom to contain at least one sender ID',
    });
  });

export const GoogleChatGroupSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    users: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const GoogleChatAccountSchema = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    allowBots: z.boolean().optional(),
    dangerouslyAllowNameMatching: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z.record(z.string(), GoogleChatGroupSchema.optional()).optional(),
    defaultTo: z.string().optional(),
    serviceAccount: z
      .union([z.string(), z.record(z.string(), z.unknown()), SecretRefSchema])
      .optional()
      .register(sensitive),
    serviceAccountRef: SecretRefSchema.optional().register(sensitive),
    serviceAccountFile: z.string().optional(),
    audienceType: z.enum(["app-url", "project-number"]).optional(),
    audience: z.string().optional(),
    appPrincipal: z.string().optional(),
    webhookPath: z.string().optional(),
    webhookUrl: z.string().optional(),
    botUser: z.string().optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    mediaMaxMb: z.number().positive().optional(),
    replyToMode: ReplyToModeSchema.optional(),
    actions: z
      .object({
        reactions: z.boolean().optional(),
      })
      .strict()
      .optional(),
    dm: GoogleChatDmSchema.optional(),
    healthMonitor: ChannelHealthMonitorSchema,
    typingIndicator: z.enum(["none", "message", "reaction"]).optional(),
    responsePrefix: z.string().optional(),
  })
  .strict();

export const GoogleChatConfigSchema = GoogleChatAccountSchema.extend({
  accounts: z.record(z.string(), GoogleChatAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
});

export const SlackDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupEnabled: z.boolean().optional(),
    groupChannels: z.array(z.union([z.string(), z.number()])).optional(),
    replyToMode: ReplyToModeSchema.optional(),
  })
  .strict();

export const SlackChannelSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    allowBots: z.boolean().optional(),
    users: z.array(z.union([z.string(), z.number()])).optional(),
    skills: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const SlackThreadSchema = z
  .object({
    historyScope: z.enum(["thread", "channel"]).optional(),
    inheritParent: z.boolean().optional(),
    initialHistoryLimit: z.number().int().min(0).optional(),
    requireExplicitMention: z.boolean().optional(),
  })
  .strict();

const SlackReplyToModeByChatTypeSchema = z
  .object({
    direct: ReplyToModeSchema.optional(),
    group: ReplyToModeSchema.optional(),
    channel: ReplyToModeSchema.optional(),
  })
  .strict();

export const SlackAccountSchema = z
  .object({
    name: z.string().optional(),
    mode: z.enum(["socket", "http"]).optional(),
    signingSecret: SecretInputSchema.optional().register(sensitive),
    webhookPath: z.string().optional(),
    capabilities: SlackCapabilitiesSchema.optional(),
    execApprovals: z
      .object({
        enabled: z.boolean().optional(),
        approvers: z.array(z.union([z.string(), z.number()])).optional(),
        agentFilter: z.array(z.string()).optional(),
        sessionFilter: z.array(z.string()).optional(),
        target: z.enum(["dm", "channel", "both"]).optional(),
      })
      .strict()
      .optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    commands: ProviderCommandsSchema,
    configWrites: z.boolean().optional(),
    botToken: SecretInputSchema.optional().register(sensitive),
    appToken: SecretInputSchema.optional().register(sensitive),
    userToken: SecretInputSchema.optional().register(sensitive),
    userTokenReadOnly: z.boolean().optional().default(true),
    allowBots: z.boolean().optional(),
    dangerouslyAllowNameMatching: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    groupPolicy: GroupPolicySchema.optional(),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    streaming: SlackStreamingConfigSchema.optional(),
    mediaMaxMb: z.number().positive().optional(),
    reactionNotifications: z.enum(["off", "own", "all", "allowlist"]).optional(),
    reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
    replyToMode: ReplyToModeSchema.optional(),
    replyToModeByChatType: SlackReplyToModeByChatTypeSchema.optional(),
    thread: SlackThreadSchema.optional(),
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
    // Aliases for channels.slack.dm.policy / channels.slack.dm.allowFrom. Prefer these for
    // inheritance in multi-account setups (shallow merge works; nested dm object doesn't).
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    defaultTo: z.string().optional(),
    dm: SlackDmSchema.optional(),
    channels: z.record(z.string(), SlackChannelSchema.optional()).optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    healthMonitor: ChannelHealthMonitorSchema,
    responsePrefix: z.string().optional(),
    ackReaction: z.string().optional(),
    typingReaction: z.string().optional(),
  })
  .strict()
  .superRefine(() => {
    // DM allowlist validation is enforced at SlackConfigSchema so account entries
    // can inherit top-level allowFrom via runtime shallow merge.
  });

export const SlackConfigSchema = SlackAccountSchema.safeExtend({
  mode: z.enum(["socket", "http"]).optional().default("socket"),
  signingSecret: SecretInputSchema.optional().register(sensitive),
  webhookPath: z.string().optional().default("/slack/events"),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  contextVisibility: ContextVisibilityModeSchema.optional(),
  accounts: z.record(z.string(), SlackAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  const dmPolicy = value.dmPolicy ?? value.dm?.policy ?? "pairing";
  const allowFrom = value.allowFrom ?? value.dm?.allowFrom;
  const allowFromPath =
    value.allowFrom !== undefined ? (["allowFrom"] as const) : (["dm", "allowFrom"] as const);
  requireOpenAllowFrom({
    policy: dmPolicy,
    allowFrom,
    ctx,
    path: [...allowFromPath],
    message:
      'channels.slack.dmPolicy="open" requires channels.slack.allowFrom (or channels.slack.dm.allowFrom) to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: dmPolicy,
    allowFrom,
    ctx,
    path: [...allowFromPath],
    message:
      'channels.slack.dmPolicy="allowlist" requires channels.slack.allowFrom (or channels.slack.dm.allowFrom) to contain at least one sender ID',
  });

  const baseMode = value.mode ?? "socket";
  if (!value.accounts) {
    validateSlackSigningSecretRequirements(value, ctx);
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    if (account.enabled === false) {
      continue;
    }
    const accountMode = account.mode ?? baseMode;
    const effectivePolicy =
      account.dmPolicy ?? account.dm?.policy ?? value.dmPolicy ?? value.dm?.policy ?? "pairing";
    const effectiveAllowFrom =
      account.allowFrom ?? account.dm?.allowFrom ?? value.allowFrom ?? value.dm?.allowFrom;
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
      continue;
    }
  }
  validateSlackSigningSecretRequirements(value, ctx);
});

const SignalGroupEntrySchema = z
  .object({
    requireMention: z.boolean().optional(),
    ingest: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
  })
  .strict();

const SignalGroupsSchema = z.record(z.string(), SignalGroupEntrySchema.optional()).optional();

export const SignalAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    account: z.string().optional(),
    accountUuid: z.string().optional(),
    httpUrl: z.string().optional(),
    httpHost: z.string().optional(),
    httpPort: z.number().int().positive().optional(),
    cliPath: ExecutableTokenSchema.optional(),
    autoStart: z.boolean().optional(),
    startupTimeoutMs: z.number().int().min(1000).max(120000).optional(),
    receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
    ignoreAttachments: z.boolean().optional(),
    ignoreStories: z.boolean().optional(),
    sendReadReceipts: z.boolean().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    defaultTo: z.string().optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    groups: SignalGroupsSchema,
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    mediaMaxMb: z.number().int().positive().optional(),
    reactionNotifications: z.enum(["off", "own", "all", "allowlist"]).optional(),
    reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
    actions: z
      .object({
        reactions: z.boolean().optional(),
      })
      .strict()
      .optional(),
    reactionLevel: z.enum(["off", "ack", "minimal", "extensive"]).optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    healthMonitor: ChannelHealthMonitorSchema,
    responsePrefix: z.string().optional(),
  })
  .strict();

// Account-level schemas skip allowFrom validation because accounts inherit
// allowFrom from the parent channel config at runtime.
// Validation is enforced at the top-level SignalConfigSchema instead.
export const SignalAccountSchema = SignalAccountSchemaBase;

export const SignalConfigSchema = SignalAccountSchemaBase.extend({
  accounts: z.record(z.string(), SignalAccountSchema.optional()).optional(),
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

export const IrcGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const IrcNickServSchema = z
  .object({
    enabled: z.boolean().optional(),
    service: z.string().optional(),
    password: SecretInputSchema.optional().register(sensitive),
    passwordFile: z.string().optional(),
    register: z.boolean().optional(),
    registerEmail: z.string().optional(),
  })
  .strict();

export const IrcAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    tls: z.boolean().optional(),
    nick: z.string().optional(),
    username: z.string().optional(),
    realname: z.string().optional(),
    password: SecretInputSchema.optional().register(sensitive),
    passwordFile: z.string().optional(),
    nickserv: IrcNickServSchema.optional(),
    channels: z.array(z.string()).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    defaultTo: z.string().optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    groups: z.record(z.string(), IrcGroupSchema.optional()).optional(),
    mentionPatterns: z.array(z.string()).optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    mediaMaxMb: z.number().positive().optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    healthMonitor: ChannelHealthMonitorSchema,
    responsePrefix: z.string().optional(),
  })
  .strict();

type IrcBaseConfig = z.infer<typeof IrcAccountSchemaBase>;

function refineIrcAllowFromAndNickserv(value: IrcBaseConfig, ctx: z.RefinementCtx): void {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.irc.dmPolicy="open" requires channels.irc.allowFrom to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.irc.dmPolicy="allowlist" requires channels.irc.allowFrom to contain at least one sender ID',
  });
  if (value.nickserv?.register && !value.nickserv.registerEmail?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nickserv", "registerEmail"],
      message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail",
    });
  }
}

// Account-level schemas skip allowFrom validation because accounts inherit
// allowFrom from the parent channel config at runtime.
// Validation is enforced at the top-level IrcConfigSchema instead.
export const IrcAccountSchema = IrcAccountSchemaBase.superRefine((value, ctx) => {
  // Only validate nickserv at account level, not allowFrom (inherited from parent).
  if (value.nickserv?.register && !value.nickserv.registerEmail?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nickserv", "registerEmail"],
      message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail",
    });
  }
});

export const IrcConfigSchema = IrcAccountSchemaBase.extend({
  accounts: z.record(z.string(), IrcAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  refineIrcAllowFromAndNickserv(value, ctx);
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
        'channels.irc.accounts.*.dmPolicy="open" requires channels.irc.accounts.*.allowFrom (or channels.irc.allowFrom) to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.irc.accounts.*.dmPolicy="allowlist" requires channels.irc.accounts.*.allowFrom (or channels.irc.allowFrom) to contain at least one sender ID',
    });
  }
});

export const IMessageAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    cliPath: ExecutableTokenSchema.optional(),
    dbPath: z.string().optional(),
    remoteHost: z
      .string()
      .refine(isSafeScpRemoteHost, "expected SSH host or user@host (no spaces/options)")
      .optional(),
    service: z.union([z.literal("imessage"), z.literal("sms"), z.literal("auto")]).optional(),
    region: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    defaultTo: z.string().optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    includeAttachments: z.boolean().optional(),
    attachmentRoots: z
      .array(z.string().refine(isValidInboundPathRootPattern, "expected absolute path root"))
      .optional(),
    remoteAttachmentRoots: z
      .array(z.string().refine(isValidInboundPathRootPattern, "expected absolute path root"))
      .optional(),
    mediaMaxMb: z.number().int().positive().optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    groups: z
      .record(
        z.string(),
        z
          .object({
            requireMention: z.boolean().optional(),
            tools: ToolPolicySchema,
            toolsBySender: ToolPolicyBySenderSchema,
          })
          .strict()
          .optional(),
      )
      .optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    healthMonitor: ChannelHealthMonitorSchema,
    responsePrefix: z.string().optional(),
  })
  .strict();

// Account-level schemas skip allowFrom validation because accounts inherit
// allowFrom from the parent channel config at runtime.
// Validation is enforced at the top-level IMessageConfigSchema instead.
export const IMessageAccountSchema = IMessageAccountSchemaBase;

export const IMessageConfigSchema = IMessageAccountSchemaBase.extend({
  accounts: z.record(z.string(), IMessageAccountSchema.optional()).optional(),
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

const BlueBubblesAllowFromEntry = z.union([z.string(), z.number()]);

const BlueBubblesActionSchema = z
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
  })
  .strict()
  .optional();

const BlueBubblesGroupConfigSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
  })
  .strict();

export const BlueBubblesAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    configWrites: z.boolean().optional(),
    enabled: z.boolean().optional(),
    serverUrl: z.string().optional(),
    password: SecretInputSchema.optional().register(sensitive),
    webhookPath: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(BlueBubblesAllowFromEntry).optional(),
    groupAllowFrom: z.array(BlueBubblesAllowFromEntry).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    sendTimeoutMs: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    mediaMaxMb: z.number().int().positive().optional(),
    mediaLocalRoots: z.array(z.string()).optional(),
    sendReadReceipts: z.boolean().optional(),
    network: z
      .object({
        dangerouslyAllowPrivateNetwork: z.boolean().optional(),
      })
      .strict()
      .optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    groups: z.record(z.string(), BlueBubblesGroupConfigSchema.optional()).optional(),
    enrichGroupParticipantsFromContacts: z.boolean().optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    healthMonitor: ChannelHealthMonitorSchema,
    responsePrefix: z.string().optional(),
    coalesceSameSenderDms: z.boolean().optional(),
  })
  .strict();

// Account-level schemas skip allowFrom validation because accounts inherit
// allowFrom from the parent channel config at runtime.
// Validation is enforced at the top-level BlueBubblesConfigSchema instead.
export const BlueBubblesAccountSchema = BlueBubblesAccountSchemaBase;

export const BlueBubblesConfigSchema = BlueBubblesAccountSchemaBase.extend({
  accounts: z.record(z.string(), BlueBubblesAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
  actions: BlueBubblesActionSchema,
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.bluebubbles.dmPolicy="open" requires channels.bluebubbles.allowFrom to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.bluebubbles.dmPolicy="allowlist" requires channels.bluebubbles.allowFrom to contain at least one sender ID',
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
        'channels.bluebubbles.accounts.*.dmPolicy="open" requires channels.bluebubbles.accounts.*.allowFrom (or channels.bluebubbles.allowFrom) to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.bluebubbles.accounts.*.dmPolicy="allowlist" requires channels.bluebubbles.accounts.*.allowFrom (or channels.bluebubbles.allowFrom) to contain at least one sender ID',
    });
  }
});

export const MSTeamsChannelSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    replyStyle: MSTeamsReplyStyleSchema.optional(),
  })
  .strict();

export const MSTeamsTeamSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    replyStyle: MSTeamsReplyStyleSchema.optional(),
    channels: z.record(z.string(), MSTeamsChannelSchema.optional()).optional(),
  })
  .strict();

export const MSTeamsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    capabilities: z.array(z.string()).optional(),
    dangerouslyAllowNameMatching: z.boolean().optional(),
    markdown: MarkdownConfigSchema,
    configWrites: z.boolean().optional(),
    appId: z.string().optional(),
    appPassword: SecretInputSchema.optional().register(sensitive),
    tenantId: z.string().optional(),
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
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.string()).optional(),
    defaultTo: z.string().optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    typingIndicator: z.boolean().optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    mediaAllowHosts: z.array(z.string()).optional(),
    mediaAuthAllowHosts: z.array(z.string()).optional(),
    requireMention: z.boolean().optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    replyStyle: MSTeamsReplyStyleSchema.optional(),
    teams: z.record(z.string(), MSTeamsTeamSchema.optional()).optional(),
    /** Max media size in MB (default: 100MB for OneDrive upload support). */
    mediaMaxMb: z.number().positive().optional(),
    /** SharePoint site ID for file uploads in group chats/channels (e.g., "contoso.sharepoint.com,guid1,guid2") */
    sharePointSiteId: z.string().optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    healthMonitor: ChannelHealthMonitorSchema,
    responsePrefix: z.string().optional(),
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

    // Federated auth fields (appId, tenantId, certificatePath,
    // useManagedIdentity) may come from MSTEAMS_* environment variables,
    // so we cannot require them in the config object itself.
    // Runtime validation happens in resolveMSTeamsCredentials().
  });
