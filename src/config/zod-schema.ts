import { z } from "zod";

import { parseDurationMs } from "../cli/parse-duration.js";
import { isSafeExecutableValue } from "../infra/exec-safety.js";

const ModelApiSchema = z.union([
  z.literal("openai-completions"),
  z.literal("openai-responses"),
  z.literal("anthropic-messages"),
  z.literal("google-generative-ai"),
]);

const ModelCompatSchema = z
  .object({
    supportsStore: z.boolean().optional(),
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
    maxTokensField: z
      .union([z.literal("max_completion_tokens"), z.literal("max_tokens")])
      .optional(),
  })
  .optional();

const ModelDefinitionSchema = z.object({
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

const ModelProviderSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  api: ModelApiSchema.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  authHeader: z.boolean().optional(),
  models: z.array(ModelDefinitionSchema),
});

const ModelsConfigSchema = z
  .object({
    mode: z.union([z.literal("merge"), z.literal("replace")]).optional(),
    providers: z.record(z.string(), ModelProviderSchema).optional(),
  })
  .optional();

const GroupChatSchema = z
  .object({
    mentionPatterns: z.array(z.string()).optional(),
    historyLimit: z.number().int().positive().optional(),
  })
  .optional();

const IdentitySchema = z
  .object({
    name: z.string().optional(),
    theme: z.string().optional(),
    emoji: z.string().optional(),
  })
  .optional();

const QueueModeSchema = z.union([
  z.literal("steer"),
  z.literal("followup"),
  z.literal("collect"),
  z.literal("steer-backlog"),
  z.literal("steer+backlog"),
  z.literal("queue"),
  z.literal("interrupt"),
]);
const QueueDropSchema = z.union([
  z.literal("old"),
  z.literal("new"),
  z.literal("summarize"),
]);
const ReplyToModeSchema = z.union([
  z.literal("off"),
  z.literal("first"),
  z.literal("all"),
]);

// GroupPolicySchema: controls how group messages are handled
// Used with .default("open").optional() pattern:
//   - .optional() allows field omission in input config
//   - .default("open") ensures runtime always resolves to "open" if not provided
const GroupPolicySchema = z.enum(["open", "disabled", "allowlist"]);

const DmPolicySchema = z.enum(["pairing", "allowlist", "open", "disabled"]);

const BlockStreamingCoalesceSchema = z.object({
  minChars: z.number().int().positive().optional(),
  maxChars: z.number().int().positive().optional(),
  idleMs: z.number().int().nonnegative().optional(),
});

const BlockStreamingChunkSchema = z.object({
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

const HumanDelaySchema = z.object({
  mode: z
    .union([z.literal("off"), z.literal("natural"), z.literal("custom")])
    .optional(),
  minMs: z.number().int().nonnegative().optional(),
  maxMs: z.number().int().nonnegative().optional(),
});

const CliBackendSchema = z.object({
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

const normalizeAllowFrom = (values?: Array<string | number>): string[] =>
  (values ?? []).map((v) => String(v).trim()).filter(Boolean);

const requireOpenAllowFrom = (params: {
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

const MSTeamsReplyStyleSchema = z.enum(["thread", "top-level"]);

const RetryConfigSchema = z
  .object({
    attempts: z.number().int().min(1).optional(),
    minDelayMs: z.number().int().min(0).optional(),
    maxDelayMs: z.number().int().min(0).optional(),
    jitter: z.number().min(0).max(1).optional(),
  })
  .optional();

const QueueModeBySurfaceSchema = z
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

const QueueSchema = z
  .object({
    mode: QueueModeSchema.optional(),
    byProvider: QueueModeBySurfaceSchema,
    debounceMs: z.number().int().nonnegative().optional(),
    cap: z.number().int().positive().optional(),
    drop: QueueDropSchema.optional(),
  })
  .optional();

const TranscribeAudioSchema = z
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

const HexColorSchema = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/, "expected hex color (RRGGBB)");

const ExecutableTokenSchema = z
  .string()
  .refine(isSafeExecutableValue, "expected safe executable name or path");

const ToolsAudioTranscriptionSchema = z
  .object({
    args: z.array(z.string()).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .optional();

const TelegramTopicSchema = z.object({
  requireMention: z.boolean().optional(),
  skills: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  systemPrompt: z.string().optional(),
});

const TelegramGroupSchema = z.object({
  requireMention: z.boolean().optional(),
  skills: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  systemPrompt: z.string().optional(),
  topics: z.record(z.string(), TelegramTopicSchema.optional()).optional(),
});

const TelegramAccountSchemaBase = z.object({
  name: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  dmPolicy: DmPolicySchema.optional().default("pairing"),
  botToken: z.string().optional(),
  tokenFile: z.string().optional(),
  replyToMode: ReplyToModeSchema.optional(),
  groups: z.record(z.string(), TelegramGroupSchema.optional()).optional(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupPolicy: GroupPolicySchema.optional().default("open"),
  historyLimit: z.number().int().min(0).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  blockStreaming: z.boolean().optional(),
  draftChunk: BlockStreamingChunkSchema.optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
  streamMode: z.enum(["off", "partial", "block"]).optional().default("partial"),
  mediaMaxMb: z.number().positive().optional(),
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

const TelegramAccountSchema = TelegramAccountSchemaBase.superRefine(
  (value, ctx) => {
    requireOpenAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'telegram.dmPolicy="open" requires telegram.allowFrom to include "*"',
    });
  },
);

const TelegramConfigSchema = TelegramAccountSchemaBase.extend({
  accounts: z.record(z.string(), TelegramAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'telegram.dmPolicy="open" requires telegram.allowFrom to include "*"',
  });
});

const DiscordDmSchema = z
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
        'discord.dm.policy="open" requires discord.dm.allowFrom to include "*"',
    });
  });

const DiscordGuildChannelSchema = z.object({
  allow: z.boolean().optional(),
  requireMention: z.boolean().optional(),
  skills: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  users: z.array(z.union([z.string(), z.number()])).optional(),
  systemPrompt: z.string().optional(),
});

const DiscordGuildSchema = z.object({
  slug: z.string().optional(),
  requireMention: z.boolean().optional(),
  reactionNotifications: z.enum(["off", "own", "all", "allowlist"]).optional(),
  users: z.array(z.union([z.string(), z.number()])).optional(),
  channels: z
    .record(z.string(), DiscordGuildChannelSchema.optional())
    .optional(),
});

const DiscordAccountSchema = z.object({
  name: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  token: z.string().optional(),
  groupPolicy: GroupPolicySchema.optional().default("open"),
  historyLimit: z.number().int().min(0).optional(),
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

const DiscordConfigSchema = DiscordAccountSchema.extend({
  accounts: z.record(z.string(), DiscordAccountSchema.optional()).optional(),
});

const SlackDmSchema = z
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
        'slack.dm.policy="open" requires slack.dm.allowFrom to include "*"',
    });
  });

const SlackChannelSchema = z.object({
  enabled: z.boolean().optional(),
  allow: z.boolean().optional(),
  requireMention: z.boolean().optional(),
  allowBots: z.boolean().optional(),
  users: z.array(z.union([z.string(), z.number()])).optional(),
  skills: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
});

const SlackAccountSchema = z.object({
  name: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  botToken: z.string().optional(),
  appToken: z.string().optional(),
  allowBots: z.boolean().optional(),
  groupPolicy: GroupPolicySchema.optional().default("open"),
  historyLimit: z.number().int().min(0).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  blockStreaming: z.boolean().optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
  mediaMaxMb: z.number().positive().optional(),
  reactionNotifications: z.enum(["off", "own", "all", "allowlist"]).optional(),
  reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
  replyToMode: ReplyToModeSchema.optional(),
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

const SlackConfigSchema = SlackAccountSchema.extend({
  accounts: z.record(z.string(), SlackAccountSchema.optional()).optional(),
});

const SignalAccountSchemaBase = z.object({
  name: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
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
  groupPolicy: GroupPolicySchema.optional().default("open"),
  historyLimit: z.number().int().min(0).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  blockStreaming: z.boolean().optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
  mediaMaxMb: z.number().int().positive().optional(),
  reactionNotifications: z.enum(["off", "own", "all", "allowlist"]).optional(),
  reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
});

const SignalAccountSchema = SignalAccountSchemaBase.superRefine(
  (value, ctx) => {
    requireOpenAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'signal.dmPolicy="open" requires signal.allowFrom to include "*"',
    });
  },
);

const SignalConfigSchema = SignalAccountSchemaBase.extend({
  accounts: z.record(z.string(), SignalAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'signal.dmPolicy="open" requires signal.allowFrom to include "*"',
  });
});

const IMessageAccountSchemaBase = z.object({
  name: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  cliPath: ExecutableTokenSchema.optional(),
  dbPath: z.string().optional(),
  service: z
    .union([z.literal("imessage"), z.literal("sms"), z.literal("auto")])
    .optional(),
  region: z.string().optional(),
  dmPolicy: DmPolicySchema.optional().default("pairing"),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupPolicy: GroupPolicySchema.optional().default("open"),
  historyLimit: z.number().int().min(0).optional(),
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

const IMessageAccountSchema = IMessageAccountSchemaBase.superRefine(
  (value, ctx) => {
    requireOpenAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'imessage.dmPolicy="open" requires imessage.allowFrom to include "*"',
    });
  },
);

const IMessageConfigSchema = IMessageAccountSchemaBase.extend({
  accounts: z.record(z.string(), IMessageAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'imessage.dmPolicy="open" requires imessage.allowFrom to include "*"',
  });
});

const MSTeamsChannelSchema = z.object({
  requireMention: z.boolean().optional(),
  replyStyle: MSTeamsReplyStyleSchema.optional(),
});

const MSTeamsTeamSchema = z.object({
  requireMention: z.boolean().optional(),
  replyStyle: MSTeamsReplyStyleSchema.optional(),
  channels: z.record(z.string(), MSTeamsChannelSchema.optional()).optional(),
});

const MSTeamsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    capabilities: z.array(z.string()).optional(),
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
    textChunkLimit: z.number().int().positive().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    mediaAllowHosts: z.array(z.string()).optional(),
    requireMention: z.boolean().optional(),
    historyLimit: z.number().int().min(0).optional(),
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
        'msteams.dmPolicy="open" requires msteams.allowFrom to include "*"',
    });
  });

const SessionSchema = z
  .object({
    scope: z.union([z.literal("per-sender"), z.literal("global")]).optional(),
    resetTriggers: z.array(z.string()).optional(),
    idleMinutes: z.number().int().positive().optional(),
    heartbeatIdleMinutes: z.number().int().positive().optional(),
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
            z.object({
              action: z.union([z.literal("allow"), z.literal("deny")]),
              match: z
                .object({
                  provider: z.string().optional(),
                  chatType: z
                    .union([
                      z.literal("direct"),
                      z.literal("group"),
                      z.literal("room"),
                    ])
                    .optional(),
                  keyPrefix: z.string().optional(),
                })
                .optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    agentToAgent: z
      .object({
        maxPingPongTurns: z.number().int().min(0).max(5).optional(),
      })
      .optional(),
  })
  .optional();

const MessagesSchema = z
  .object({
    messagePrefix: z.string().optional(),
    responsePrefix: z.string().optional(),
    groupChat: GroupChatSchema,
    queue: QueueSchema,
    ackReaction: z.string().optional(),
    ackReactionScope: z
      .enum(["group-mentions", "group-all", "direct", "all"])
      .optional(),
    removeAckAfterReply: z.boolean().optional(),
  })
  .optional();

const CommandsSchema = z
  .object({
    native: z.boolean().optional(),
    text: z.boolean().optional(),
    config: z.boolean().optional(),
    debug: z.boolean().optional(),
    restart: z.boolean().optional(),
    useAccessGroups: z.boolean().optional(),
  })
  .optional();

const HeartbeatSchema = z
  .object({
    every: z.string().optional(),
    model: z.string().optional(),
    includeReasoning: z.boolean().optional(),
    target: z
      .union([
        z.literal("last"),
        z.literal("whatsapp"),
        z.literal("telegram"),
        z.literal("discord"),
        z.literal("slack"),
        z.literal("msteams"),
        z.literal("signal"),
        z.literal("imessage"),
        z.literal("none"),
      ])
      .optional(),
    to: z.string().optional(),
    prompt: z.string().optional(),
    ackMaxChars: z.number().int().nonnegative().optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.every) return;
    try {
      parseDurationMs(val.every, { defaultUnit: "m" });
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["every"],
        message: "invalid duration (use ms, s, m, h)",
      });
    }
  })
  .optional();

const SandboxDockerSchema = z
  .object({
    image: z.string().optional(),
    containerPrefix: z.string().optional(),
    workdir: z.string().optional(),
    readOnlyRoot: z.boolean().optional(),
    tmpfs: z.array(z.string()).optional(),
    network: z.string().optional(),
    user: z.string().optional(),
    capDrop: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    setupCommand: z.string().optional(),
    pidsLimit: z.number().int().positive().optional(),
    memory: z.union([z.string(), z.number()]).optional(),
    memorySwap: z.union([z.string(), z.number()]).optional(),
    cpus: z.number().positive().optional(),
    ulimits: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.number(),
          z.object({
            soft: z.number().int().nonnegative().optional(),
            hard: z.number().int().nonnegative().optional(),
          }),
        ]),
      )
      .optional(),
    seccompProfile: z.string().optional(),
    apparmorProfile: z.string().optional(),
    dns: z.array(z.string()).optional(),
    extraHosts: z.array(z.string()).optional(),
  })
  .optional();

const SandboxBrowserSchema = z
  .object({
    enabled: z.boolean().optional(),
    image: z.string().optional(),
    containerPrefix: z.string().optional(),
    cdpPort: z.number().int().positive().optional(),
    vncPort: z.number().int().positive().optional(),
    noVncPort: z.number().int().positive().optional(),
    headless: z.boolean().optional(),
    enableNoVnc: z.boolean().optional(),
    allowHostControl: z.boolean().optional(),
    allowedControlUrls: z.array(z.string()).optional(),
    allowedControlHosts: z.array(z.string()).optional(),
    allowedControlPorts: z.array(z.number().int().positive()).optional(),
    autoStart: z.boolean().optional(),
    autoStartTimeoutMs: z.number().int().positive().optional(),
  })
  .optional();

const SandboxPruneSchema = z
  .object({
    idleHours: z.number().int().nonnegative().optional(),
    maxAgeDays: z.number().int().nonnegative().optional(),
  })
  .optional();

const ToolPolicySchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .optional();

// Provider docking: allowlists keyed by provider id (no schema updates when adding providers).
const ElevatedAllowFromSchema = z
  .record(z.string(), z.array(z.union([z.string(), z.number()])))
  .optional();

const AgentSandboxSchema = z
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
      .union([z.literal("session"), z.literal("agent"), z.literal("shared")])
      .optional(),
    perSession: z.boolean().optional(),
    workspaceRoot: z.string().optional(),
    docker: SandboxDockerSchema,
    browser: SandboxBrowserSchema,
    prune: SandboxPruneSchema,
  })
  .optional();

const AgentToolsSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    elevated: z
      .object({
        enabled: z.boolean().optional(),
        allowFrom: ElevatedAllowFromSchema,
      })
      .optional(),
    sandbox: z
      .object({
        tools: ToolPolicySchema,
      })
      .optional(),
  })
  .optional();

const AgentEntrySchema = z.object({
  id: z.string(),
  default: z.boolean().optional(),
  name: z.string().optional(),
  workspace: z.string().optional(),
  agentDir: z.string().optional(),
  model: z.string().optional(),
  humanDelay: HumanDelaySchema.optional(),
  identity: IdentitySchema,
  groupChat: GroupChatSchema,
  subagents: z
    .object({
      allowAgents: z.array(z.string()).optional(),
    })
    .optional(),
  sandbox: AgentSandboxSchema,
  tools: AgentToolsSchema,
});

const ToolsSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    audio: z
      .object({
        transcription: ToolsAudioTranscriptionSchema,
      })
      .optional(),
    agentToAgent: z
      .object({
        enabled: z.boolean().optional(),
        allow: z.array(z.string()).optional(),
      })
      .optional(),
    elevated: z
      .object({
        enabled: z.boolean().optional(),
        allowFrom: ElevatedAllowFromSchema,
      })
      .optional(),
    bash: z
      .object({
        backgroundMs: z.number().int().positive().optional(),
        timeoutSec: z.number().int().positive().optional(),
        cleanupMs: z.number().int().positive().optional(),
      })
      .optional(),
    subagents: z
      .object({
        tools: ToolPolicySchema,
      })
      .optional(),
    sandbox: z
      .object({
        tools: ToolPolicySchema,
      })
      .optional(),
  })
  .optional();

const AgentsSchema = z
  .object({
    defaults: z.lazy(() => AgentDefaultsSchema).optional(),
    list: z.array(AgentEntrySchema).optional(),
  })
  .optional();

const BindingsSchema = z
  .array(
    z.object({
      agentId: z.string(),
      match: z.object({
        provider: z.string(),
        accountId: z.string().optional(),
        peer: z
          .object({
            kind: z.union([
              z.literal("dm"),
              z.literal("group"),
              z.literal("channel"),
            ]),
            id: z.string(),
          })
          .optional(),
        guildId: z.string().optional(),
        teamId: z.string().optional(),
      }),
    }),
  )
  .optional();

const BroadcastStrategySchema = z.enum(["parallel", "sequential"]);

const BroadcastSchema = z
  .object({
    strategy: BroadcastStrategySchema.optional(),
  })
  .catchall(z.array(z.string()))
  .optional();

const AudioSchema = z
  .object({
    transcription: TranscribeAudioSchema,
  })
  .optional();

const HookMappingSchema = z
  .object({
    id: z.string().optional(),
    match: z
      .object({
        path: z.string().optional(),
        source: z.string().optional(),
      })
      .optional(),
    action: z.union([z.literal("wake"), z.literal("agent")]).optional(),
    wakeMode: z
      .union([z.literal("now"), z.literal("next-heartbeat")])
      .optional(),
    name: z.string().optional(),
    sessionKey: z.string().optional(),
    messageTemplate: z.string().optional(),
    textTemplate: z.string().optional(),
    deliver: z.boolean().optional(),
    provider: z
      .union([
        z.literal("last"),
        z.literal("whatsapp"),
        z.literal("telegram"),
        z.literal("discord"),
        z.literal("slack"),
        z.literal("signal"),
        z.literal("imessage"),
        z.literal("msteams"),
      ])
      .optional(),
    to: z.string().optional(),
    model: z.string().optional(),
    thinking: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    transform: z
      .object({
        module: z.string(),
        export: z.string().optional(),
      })
      .optional(),
  })
  .optional();

const HooksGmailSchema = z
  .object({
    account: z.string().optional(),
    label: z.string().optional(),
    topic: z.string().optional(),
    subscription: z.string().optional(),
    pushToken: z.string().optional(),
    hookUrl: z.string().optional(),
    includeBody: z.boolean().optional(),
    maxBytes: z.number().int().positive().optional(),
    renewEveryMinutes: z.number().int().positive().optional(),
    serve: z
      .object({
        bind: z.string().optional(),
        port: z.number().int().positive().optional(),
        path: z.string().optional(),
      })
      .optional(),
    tailscale: z
      .object({
        mode: z
          .union([z.literal("off"), z.literal("serve"), z.literal("funnel")])
          .optional(),
        path: z.string().optional(),
        target: z.string().optional(),
      })
      .optional(),
    model: z.string().optional(),
    thinking: z
      .union([
        z.literal("off"),
        z.literal("minimal"),
        z.literal("low"),
        z.literal("medium"),
        z.literal("high"),
      ])
      .optional(),
  })
  .optional();

const AgentDefaultsSchema = z
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
    userTimezone: z.string().optional(),
    contextTokens: z.number().int().positive().optional(),
    cliBackends: z.record(z.string(), CliBackendSchema).optional(),
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
    thinkingDefault: z
      .union([
        z.literal("off"),
        z.literal("minimal"),
        z.literal("low"),
        z.literal("medium"),
        z.literal("high"),
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
export const ClawdbotSchema = z
  .object({
    env: z
      .object({
        shellEnv: z
          .object({
            enabled: z.boolean().optional(),
            timeoutMs: z.number().int().nonnegative().optional(),
          })
          .optional(),
        vars: z.record(z.string(), z.string()).optional(),
      })
      .catchall(z.string())
      .optional(),
    wizard: z
      .object({
        lastRunAt: z.string().optional(),
        lastRunVersion: z.string().optional(),
        lastRunCommit: z.string().optional(),
        lastRunCommand: z.string().optional(),
        lastRunMode: z
          .union([z.literal("local"), z.literal("remote")])
          .optional(),
      })
      .optional(),
    logging: z
      .object({
        level: z
          .union([
            z.literal("silent"),
            z.literal("fatal"),
            z.literal("error"),
            z.literal("warn"),
            z.literal("info"),
            z.literal("debug"),
            z.literal("trace"),
          ])
          .optional(),
        file: z.string().optional(),
        consoleLevel: z
          .union([
            z.literal("silent"),
            z.literal("fatal"),
            z.literal("error"),
            z.literal("warn"),
            z.literal("info"),
            z.literal("debug"),
            z.literal("trace"),
          ])
          .optional(),
        consoleStyle: z
          .union([z.literal("pretty"), z.literal("compact"), z.literal("json")])
          .optional(),
        redactSensitive: z
          .union([z.literal("off"), z.literal("tools")])
          .optional(),
        redactPatterns: z.array(z.string()).optional(),
      })
      .optional(),
    browser: z
      .object({
        enabled: z.boolean().optional(),
        controlUrl: z.string().optional(),
        cdpUrl: z.string().optional(),
        color: z.string().optional(),
        executablePath: z.string().optional(),
        headless: z.boolean().optional(),
        noSandbox: z.boolean().optional(),
        attachOnly: z.boolean().optional(),
        defaultProfile: z.string().optional(),
        profiles: z
          .record(
            z
              .string()
              .regex(
                /^[a-z0-9-]+$/,
                "Profile names must be alphanumeric with hyphens only",
              ),
            z
              .object({
                cdpPort: z.number().int().min(1).max(65535).optional(),
                cdpUrl: z.string().optional(),
                color: HexColorSchema,
              })
              .refine((value) => value.cdpPort || value.cdpUrl, {
                message: "Profile must set cdpPort or cdpUrl",
              }),
          )
          .optional(),
      })
      .optional(),
    ui: z
      .object({
        seamColor: HexColorSchema.optional(),
      })
      .optional(),
    auth: z
      .object({
        profiles: z
          .record(
            z.string(),
            z.object({
              provider: z.string(),
              mode: z.union([
                z.literal("api_key"),
                z.literal("oauth"),
                z.literal("token"),
              ]),
              email: z.string().optional(),
            }),
          )
          .optional(),
        order: z.record(z.string(), z.array(z.string())).optional(),
        cooldowns: z
          .object({
            billingBackoffHours: z.number().positive().optional(),
            billingBackoffHoursByProvider: z
              .record(z.string(), z.number().positive())
              .optional(),
            billingMaxHours: z.number().positive().optional(),
            failureWindowHours: z.number().positive().optional(),
          })
          .optional(),
      })
      .optional(),
    models: ModelsConfigSchema,
    agents: AgentsSchema,
    tools: ToolsSchema,
    bindings: BindingsSchema,
    broadcast: BroadcastSchema,
    audio: AudioSchema,
    messages: MessagesSchema,
    commands: CommandsSchema,
    session: SessionSchema,
    cron: z
      .object({
        enabled: z.boolean().optional(),
        store: z.string().optional(),
        maxConcurrentRuns: z.number().int().positive().optional(),
      })
      .optional(),
    hooks: z
      .object({
        enabled: z.boolean().optional(),
        path: z.string().optional(),
        token: z.string().optional(),
        maxBodyBytes: z.number().int().positive().optional(),
        presets: z.array(z.string()).optional(),
        transformsDir: z.string().optional(),
        mappings: z.array(HookMappingSchema).optional(),
        gmail: HooksGmailSchema,
      })
      .optional(),
    web: z
      .object({
        enabled: z.boolean().optional(),
        heartbeatSeconds: z.number().int().positive().optional(),
        reconnect: z
          .object({
            initialMs: z.number().positive().optional(),
            maxMs: z.number().positive().optional(),
            factor: z.number().positive().optional(),
            jitter: z.number().min(0).max(1).optional(),
            maxAttempts: z.number().int().min(0).optional(),
          })
          .optional(),
      })
      .optional(),
    whatsapp: z
      .object({
        accounts: z
          .record(
            z.string(),
            z
              .object({
                name: z.string().optional(),
                capabilities: z.array(z.string()).optional(),
                enabled: z.boolean().optional(),
                messagePrefix: z.string().optional(),
                /** Override auth directory for this WhatsApp account (Baileys multi-file auth state). */
                authDir: z.string().optional(),
                dmPolicy: DmPolicySchema.optional().default("pairing"),
                selfChatMode: z.boolean().optional(),
                allowFrom: z.array(z.string()).optional(),
                groupAllowFrom: z.array(z.string()).optional(),
                groupPolicy: GroupPolicySchema.optional().default("open"),
                historyLimit: z.number().int().min(0).optional(),
                textChunkLimit: z.number().int().positive().optional(),
                mediaMaxMb: z.number().int().positive().optional(),
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
                ackReaction: z
                  .object({
                    emoji: z.string().optional(),
                    direct: z.boolean().optional().default(true),
                    group: z
                      .enum(["always", "mentions", "never"])
                      .optional()
                      .default("mentions"),
                  })
                  .optional(),
              })
              .superRefine((value, ctx) => {
                if (value.dmPolicy !== "open") return;
                const allow = (value.allowFrom ?? [])
                  .map((v) => String(v).trim())
                  .filter(Boolean);
                if (allow.includes("*")) return;
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ["allowFrom"],
                  message:
                    'whatsapp.accounts.*.dmPolicy="open" requires allowFrom to include "*"',
                });
              })
              .optional(),
          )
          .optional(),
        capabilities: z.array(z.string()).optional(),
        dmPolicy: DmPolicySchema.optional().default("pairing"),
        messagePrefix: z.string().optional(),
        selfChatMode: z.boolean().optional(),
        allowFrom: z.array(z.string()).optional(),
        groupAllowFrom: z.array(z.string()).optional(),
        groupPolicy: GroupPolicySchema.optional().default("open"),
        historyLimit: z.number().int().min(0).optional(),
        textChunkLimit: z.number().int().positive().optional(),
        mediaMaxMb: z.number().int().positive().optional().default(50),
        blockStreaming: z.boolean().optional(),
        blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
        actions: z
          .object({
            reactions: z.boolean().optional(),
            sendMessage: z.boolean().optional(),
            polls: z.boolean().optional(),
          })
          .optional(),
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
        ackReaction: z
          .object({
            emoji: z.string().optional(),
            direct: z.boolean().optional().default(true),
            group: z
              .enum(["always", "mentions", "never"])
              .optional()
              .default("mentions"),
          })
          .optional(),
      })
      .superRefine((value, ctx) => {
        if (value.dmPolicy !== "open") return;
        const allow = (value.allowFrom ?? [])
          .map((v) => String(v).trim())
          .filter(Boolean);
        if (allow.includes("*")) return;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowFrom"],
          message:
            'whatsapp.dmPolicy="open" requires whatsapp.allowFrom to include "*"',
        });
      })
      .optional(),
    telegram: TelegramConfigSchema.optional(),
    discord: DiscordConfigSchema.optional(),
    slack: SlackConfigSchema.optional(),
    signal: SignalConfigSchema.optional(),
    imessage: IMessageConfigSchema.optional(),
    msteams: MSTeamsConfigSchema.optional(),
    bridge: z
      .object({
        enabled: z.boolean().optional(),
        port: z.number().int().positive().optional(),
        bind: z
          .union([
            z.literal("auto"),
            z.literal("lan"),
            z.literal("tailnet"),
            z.literal("loopback"),
          ])
          .optional(),
      })
      .optional(),
    discovery: z
      .object({
        wideArea: z
          .object({
            enabled: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    canvasHost: z
      .object({
        enabled: z.boolean().optional(),
        root: z.string().optional(),
        port: z.number().int().positive().optional(),
        liveReload: z.boolean().optional(),
      })
      .optional(),
    talk: z
      .object({
        voiceId: z.string().optional(),
        voiceAliases: z.record(z.string(), z.string()).optional(),
        modelId: z.string().optional(),
        outputFormat: z.string().optional(),
        apiKey: z.string().optional(),
        interruptOnSpeech: z.boolean().optional(),
      })
      .optional(),
    gateway: z
      .object({
        port: z.number().int().positive().optional(),
        mode: z.union([z.literal("local"), z.literal("remote")]).optional(),
        bind: z
          .union([
            z.literal("auto"),
            z.literal("lan"),
            z.literal("tailnet"),
            z.literal("loopback"),
          ])
          .optional(),
        controlUi: z
          .object({
            enabled: z.boolean().optional(),
            basePath: z.string().optional(),
          })
          .optional(),
        auth: z
          .object({
            mode: z
              .union([z.literal("token"), z.literal("password")])
              .optional(),
            token: z.string().optional(),
            password: z.string().optional(),
            allowTailscale: z.boolean().optional(),
          })
          .optional(),
        tailscale: z
          .object({
            mode: z
              .union([
                z.literal("off"),
                z.literal("serve"),
                z.literal("funnel"),
              ])
              .optional(),
            resetOnExit: z.boolean().optional(),
          })
          .optional(),
        remote: z
          .object({
            url: z.string().optional(),
            token: z.string().optional(),
            password: z.string().optional(),
            sshTarget: z.string().optional(),
            sshIdentity: z.string().optional(),
          })
          .optional(),
        reload: z
          .object({
            mode: z
              .union([
                z.literal("off"),
                z.literal("restart"),
                z.literal("hot"),
                z.literal("hybrid"),
              ])
              .optional(),
            debounceMs: z.number().int().min(0).optional(),
          })
          .optional(),
        http: z
          .object({
            endpoints: z
              .object({
                chatCompletions: z
                  .object({
                    enabled: z.boolean().optional(),
                  })
                  .optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .optional(),
    skills: z
      .object({
        allowBundled: z.array(z.string()).optional(),
        load: z
          .object({
            extraDirs: z.array(z.string()).optional(),
          })
          .optional(),
        install: z
          .object({
            preferBrew: z.boolean().optional(),
            nodeManager: z
              .union([
                z.literal("npm"),
                z.literal("pnpm"),
                z.literal("yarn"),
                z.literal("bun"),
              ])
              .optional(),
          })
          .optional(),
        entries: z
          .record(
            z.string(),
            z
              .object({
                enabled: z.boolean().optional(),
                apiKey: z.string().optional(),
                env: z.record(z.string(), z.string()).optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .optional(),
  })
  .superRefine((cfg, ctx) => {
    const agents = cfg.agents?.list ?? [];
    if (agents.length === 0) return;
    const agentIds = new Set(agents.map((agent) => agent.id));

    const broadcast = cfg.broadcast;
    if (!broadcast) return;

    for (const [peerId, ids] of Object.entries(broadcast)) {
      if (peerId === "strategy") continue;
      if (!Array.isArray(ids)) continue;
      for (let idx = 0; idx < ids.length; idx += 1) {
        const agentId = ids[idx];
        if (!agentIds.has(agentId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["broadcast", peerId, idx],
            message: `Unknown agent id "${agentId}" (not in agents.list).`,
          });
        }
      }
    }
  });
