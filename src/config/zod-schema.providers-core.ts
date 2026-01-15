import { z } from "zod";

import {
  BlockStreamingChunkSchema,
  BlockStreamingCoalesceSchema,
  DmConfigSchema,
  DmPolicySchema,
  ExecutableTokenSchema,
  GroupPolicySchema,
  MSTeamsReplyStyleSchema,
  ProviderCommandsSchema,
  ReplyToModeSchema,
  RetryConfigSchema,
  requireOpenAllowFrom,
} from "./zod-schema.core.js";

export const TelegramTopicSchema = z.object({
  requireMention: z.boolean().optional(),
  skills: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  systemPrompt: z.string().optional(),
});

export const TelegramGroupSchema = z.object({
  requireMention: z.boolean().optional(),
  skills: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  systemPrompt: z.string().optional(),
  topics: z.record(z.string(), TelegramTopicSchema.optional()).optional(),
});

export const TelegramAccountSchemaBase = z.object({
  name: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  commands: ProviderCommandsSchema,
  configWrites: z.boolean().optional(),
  dmPolicy: DmPolicySchema.optional().default("pairing"),
  botToken: z.string().optional(),
  tokenFile: z.string().optional(),
  replyToMode: ReplyToModeSchema.optional(),
  groups: z.record(z.string(), TelegramGroupSchema.optional()).optional(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  historyLimit: z.number().int().min(0).optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  blockStreaming: z.boolean().optional(),
  draftChunk: BlockStreamingChunkSchema.optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
  streamMode: z.enum(["off", "partial", "block"]).optional().default("partial"),
  mediaMaxMb: z.number().positive().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  retry: RetryConfigSchema,
  proxy: z.string().optional(),
  webhookUrl: z.string().optional(),
  webhookSecret: z.string().optional(),
  webhookPath: z.string().optional(),
  actions: z
    .object({
      reactions: z.boolean().optional(),
    })
    .optional(),
});

export const TelegramAccountSchema = TelegramAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.telegram.dmPolicy="open" requires channels.telegram.allowFrom to include "*"',
  });
});

export const TelegramConfigSchema = TelegramAccountSchemaBase.extend({
  accounts: z.record(z.string(), TelegramAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.telegram.dmPolicy="open" requires channels.telegram.allowFrom to include "*"',
  });
});

export const DiscordDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupEnabled: z.boolean().optional(),
    groupChannels: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .superRefine((value, ctx) => {
    requireOpenAllowFrom({
      policy: value.policy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.discord.dm.policy="open" requires channels.discord.dm.allowFrom to include "*"',
    });
  });

export const DiscordGuildChannelSchema = z.object({
  allow: z.boolean().optional(),
  requireMention: z.boolean().optional(),
  skills: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  users: z.array(z.union([z.string(), z.number()])).optional(),
  systemPrompt: z.string().optional(),
  autoThread: z.boolean().optional(),
});

export const DiscordGuildSchema = z.object({
  slug: z.string().optional(),
  requireMention: z.boolean().optional(),
  reactionNotifications: z.enum(["off", "own", "all", "allowlist"]).optional(),
  users: z.array(z.union([z.string(), z.number()])).optional(),
  channels: z.record(z.string(), DiscordGuildChannelSchema.optional()).optional(),
});

export const DiscordAccountSchema = z.object({
  name: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  commands: ProviderCommandsSchema,
  configWrites: z.boolean().optional(),
  token: z.string().optional(),
  allowBots: z.boolean().optional(),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  historyLimit: z.number().int().min(0).optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  blockStreaming: z.boolean().optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
  maxLinesPerMessage: z.number().int().positive().optional(),
  mediaMaxMb: z.number().positive().optional(),
  retry: RetryConfigSchema,
  actions: z
    .object({
      reactions: z.boolean().optional(),
      stickers: z.boolean().optional(),
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
    })
    .optional(),
  replyToMode: ReplyToModeSchema.optional(),
  dm: DiscordDmSchema.optional(),
  guilds: z.record(z.string(), DiscordGuildSchema.optional()).optional(),
});

export const DiscordConfigSchema = DiscordAccountSchema.extend({
  accounts: z.record(z.string(), DiscordAccountSchema.optional()).optional(),
});

export const SlackDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupEnabled: z.boolean().optional(),
    groupChannels: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .superRefine((value, ctx) => {
    requireOpenAllowFrom({
      policy: value.policy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.slack.dm.policy="open" requires channels.slack.dm.allowFrom to include "*"',
    });
  });

export const SlackChannelSchema = z.object({
  enabled: z.boolean().optional(),
  allow: z.boolean().optional(),
  requireMention: z.boolean().optional(),
  allowBots: z.boolean().optional(),
  users: z.array(z.union([z.string(), z.number()])).optional(),
  skills: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
});

export const SlackThreadSchema = z.object({
  historyScope: z.enum(["thread", "channel"]).optional(),
  inheritParent: z.boolean().optional(),
});

export const SlackAccountSchema = z.object({
  name: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  commands: ProviderCommandsSchema,
  configWrites: z.boolean().optional(),
  botToken: z.string().optional(),
  appToken: z.string().optional(),
  allowBots: z.boolean().optional(),
  requireMention: z.boolean().optional(),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  historyLimit: z.number().int().min(0).optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  blockStreaming: z.boolean().optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
  mediaMaxMb: z.number().positive().optional(),
  reactionNotifications: z.enum(["off", "own", "all", "allowlist"]).optional(),
  reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
  replyToMode: ReplyToModeSchema.optional(),
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
    .optional(),
  slashCommand: z
    .object({
      enabled: z.boolean().optional(),
      name: z.string().optional(),
      sessionPrefix: z.string().optional(),
      ephemeral: z.boolean().optional(),
    })
    .optional(),
  dm: SlackDmSchema.optional(),
  channels: z.record(z.string(), SlackChannelSchema.optional()).optional(),
});

export const SlackConfigSchema = SlackAccountSchema.extend({
  accounts: z.record(z.string(), SlackAccountSchema.optional()).optional(),
});

export const SignalAccountSchemaBase = z.object({
  name: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  configWrites: z.boolean().optional(),
  account: z.string().optional(),
  httpUrl: z.string().optional(),
  httpHost: z.string().optional(),
  httpPort: z.number().int().positive().optional(),
  cliPath: ExecutableTokenSchema.optional(),
  autoStart: z.boolean().optional(),
  receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
  ignoreAttachments: z.boolean().optional(),
  ignoreStories: z.boolean().optional(),
  sendReadReceipts: z.boolean().optional(),
  dmPolicy: DmPolicySchema.optional().default("pairing"),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  historyLimit: z.number().int().min(0).optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  blockStreaming: z.boolean().optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
  mediaMaxMb: z.number().int().positive().optional(),
  reactionNotifications: z.enum(["off", "own", "all", "allowlist"]).optional(),
  reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
});

export const SignalAccountSchema = SignalAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.signal.dmPolicy="open" requires channels.signal.allowFrom to include "*"',
  });
});

export const SignalConfigSchema = SignalAccountSchemaBase.extend({
  accounts: z.record(z.string(), SignalAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.signal.dmPolicy="open" requires channels.signal.allowFrom to include "*"',
  });
});

export const IMessageAccountSchemaBase = z.object({
  name: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  configWrites: z.boolean().optional(),
  cliPath: ExecutableTokenSchema.optional(),
  dbPath: z.string().optional(),
  service: z.union([z.literal("imessage"), z.literal("sms"), z.literal("auto")]).optional(),
  region: z.string().optional(),
  dmPolicy: DmPolicySchema.optional().default("pairing"),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  historyLimit: z.number().int().min(0).optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
  includeAttachments: z.boolean().optional(),
  mediaMaxMb: z.number().int().positive().optional(),
  textChunkLimit: z.number().int().positive().optional(),
  blockStreaming: z.boolean().optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
  groups: z
    .record(
      z.string(),
      z
        .object({
          requireMention: z.boolean().optional(),
        })
        .optional(),
    )
    .optional(),
});

export const IMessageAccountSchema = IMessageAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.imessage.dmPolicy="open" requires channels.imessage.allowFrom to include "*"',
  });
});

export const IMessageConfigSchema = IMessageAccountSchemaBase.extend({
  accounts: z.record(z.string(), IMessageAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.imessage.dmPolicy="open" requires channels.imessage.allowFrom to include "*"',
  });
});

export const MSTeamsChannelSchema = z.object({
  requireMention: z.boolean().optional(),
  replyStyle: MSTeamsReplyStyleSchema.optional(),
});

export const MSTeamsTeamSchema = z.object({
  requireMention: z.boolean().optional(),
  replyStyle: MSTeamsReplyStyleSchema.optional(),
  channels: z.record(z.string(), MSTeamsChannelSchema.optional()).optional(),
});

export const MSTeamsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    capabilities: z.array(z.string()).optional(),
    configWrites: z.boolean().optional(),
    appId: z.string().optional(),
    appPassword: z.string().optional(),
    tenantId: z.string().optional(),
    webhook: z
      .object({
        port: z.number().int().positive().optional(),
        path: z.string().optional(),
      })
      .optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    textChunkLimit: z.number().int().positive().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    mediaAllowHosts: z.array(z.string()).optional(),
    requireMention: z.boolean().optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    replyStyle: MSTeamsReplyStyleSchema.optional(),
    teams: z.record(z.string(), MSTeamsTeamSchema.optional()).optional(),
  })
  .superRefine((value, ctx) => {
    requireOpenAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.msteams.dmPolicy="open" requires channels.msteams.allowFrom to include "*"',
    });
  });
