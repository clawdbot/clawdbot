import { z } from "zod";

import { parseDurationMs } from "../cli/parse-duration.js";

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
  apiKey: z.string().min(1),
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

const QueueModeBySurfaceSchema = z
  .object({
    whatsapp: QueueModeSchema.optional(),
    telegram: QueueModeSchema.optional(),
    discord: QueueModeSchema.optional(),
    slack: QueueModeSchema.optional(),
    signal: QueueModeSchema.optional(),
    imessage: QueueModeSchema.optional(),
    webchat: QueueModeSchema.optional(),
  })
  .optional();

const TranscribeAudioSchema = z
  .object({
    command: z.array(z.string()),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .optional();

const HexColorSchema = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/, "expected hex color (RRGGBB)");

const SessionSchema = z
  .object({
    scope: z.union([z.literal("per-sender"), z.literal("global")]).optional(),
    resetTriggers: z.array(z.string()).optional(),
    idleMinutes: z.number().int().positive().optional(),
    heartbeatIdleMinutes: z.number().int().positive().optional(),
    store: z.string().optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
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
                  surface: z.string().optional(),
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
    timestampPrefix: z.union([z.boolean(), z.string()]).optional(),
  })
  .optional();

const HeartbeatSchema = z
  .object({
    every: z.string().optional(),
    model: z.string().optional(),
    target: z
      .union([
        z.literal("last"),
        z.literal("whatsapp"),
        z.literal("telegram"),
        z.literal("discord"),
        z.literal("slack"),
        z.literal("signal"),
        z.literal("imessage"),
        z.literal("none"),
      ])
      .optional(),
    to: z.string().optional(),
    prompt: z.string().optional(),
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

const RoutingSchema = z
  .object({
    groupChat: GroupChatSchema,
    transcribeAudio: TranscribeAudioSchema,
    queue: z
      .object({
        mode: QueueModeSchema.optional(),
        bySurface: QueueModeBySurfaceSchema,
        debounceMs: z.number().int().nonnegative().optional(),
        cap: z.number().int().positive().optional(),
        drop: QueueDropSchema.optional(),
      })
      .optional(),
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
    channel: z
      .union([
        z.literal("last"),
        z.literal("whatsapp"),
        z.literal("telegram"),
        z.literal("discord"),
        z.literal("slack"),
        z.literal("signal"),
        z.literal("imessage"),
      ])
      .optional(),
    to: z.string().optional(),
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
      })
      .optional(),
  })
  .optional();

export const ClawdbotSchema = z.object({
  env: z
    .object({
      shellEnv: z
        .object({
          enabled: z.boolean().optional(),
          timeoutMs: z.number().int().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
  identity: z
    .object({
      name: z.string().optional(),
      theme: z.string().optional(),
      emoji: z.string().optional(),
    })
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
  models: ModelsConfigSchema,
  agent: z
    .object({
      model: z.string().optional(),
      imageModel: z.string().optional(),
      workspace: z.string().optional(),
      allowedModels: z.array(z.string()).optional(),
      modelAliases: z.record(z.string(), z.string()).optional(),
      modelFallbacks: z.array(z.string()).optional(),
      imageModelFallbacks: z.array(z.string()).optional(),
      contextTokens: z.number().int().positive().optional(),
      tools: z
        .object({
          allow: z.array(z.string()).optional(),
          deny: z.array(z.string()).optional(),
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
      blockStreamingChunk: z
        .object({
          minChars: z.number().int().positive().optional(),
          maxChars: z.number().int().positive().optional(),
          breakPreference: z
            .union([
              z.literal("paragraph"),
              z.literal("newline"),
              z.literal("sentence"),
            ])
            .optional(),
        })
        .optional(),
      timeoutSeconds: z.number().int().positive().optional(),
      mediaMaxMb: z.number().positive().optional(),
      typingIntervalSeconds: z.number().int().positive().optional(),
      heartbeat: HeartbeatSchema,
      maxConcurrent: z.number().int().positive().optional(),
      bash: z
        .object({
          backgroundMs: z.number().int().positive().optional(),
          timeoutSec: z.number().int().positive().optional(),
          cleanupMs: z.number().int().positive().optional(),
        })
        .optional(),
      elevated: z
        .object({
          enabled: z.boolean().optional(),
          allowFrom: z
            .object({
              whatsapp: z.array(z.string()).optional(),
              telegram: z.array(z.union([z.string(), z.number()])).optional(),
              discord: z.array(z.union([z.string(), z.number()])).optional(),
              slack: z.array(z.union([z.string(), z.number()])).optional(),
              signal: z.array(z.union([z.string(), z.number()])).optional(),
              imessage: z.array(z.union([z.string(), z.number()])).optional(),
              webchat: z.array(z.union([z.string(), z.number()])).optional(),
            })
            .optional(),
        })
        .optional(),
      sandbox: z
        .object({
          mode: z
            .union([z.literal("off"), z.literal("non-main"), z.literal("all")])
            .optional(),
          perSession: z.boolean().optional(),
          workspaceRoot: z.string().optional(),
          docker: z
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
            .optional(),
          browser: z
            .object({
              enabled: z.boolean().optional(),
              image: z.string().optional(),
              containerPrefix: z.string().optional(),
              cdpPort: z.number().int().positive().optional(),
              vncPort: z.number().int().positive().optional(),
              noVncPort: z.number().int().positive().optional(),
              headless: z.boolean().optional(),
              enableNoVnc: z.boolean().optional(),
            })
            .optional(),
          tools: z
            .object({
              allow: z.array(z.string()).optional(),
              deny: z.array(z.string()).optional(),
            })
            .optional(),
          prune: z
            .object({
              idleHours: z.number().int().nonnegative().optional(),
              maxAgeDays: z.number().int().nonnegative().optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
  routing: RoutingSchema,
  messages: MessagesSchema,
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
      allowFrom: z.array(z.string()).optional(),
      textChunkLimit: z.number().int().positive().optional(),
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
    })
    .optional(),
  telegram: z
    .object({
      enabled: z.boolean().optional(),
      botToken: z.string().optional(),
      tokenFile: z.string().optional(),
      replyToMode: ReplyToModeSchema.optional(),
      groups: z
        .record(
          z.string(),
          z
            .object({
              requireMention: z.boolean().optional(),
              skills: z.array(z.string()).optional(),
              enabled: z.boolean().optional(),
              autoReply: z.boolean().optional(),
              allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
              systemPrompt: z.string().optional(),
              topics: z
                .record(
                  z.string(),
                  z
                    .object({
                      skills: z.array(z.string()).optional(),
                      enabled: z.boolean().optional(),
                      autoReply: z.boolean().optional(),
                      allowFrom: z
                        .array(z.union([z.string(), z.number()]))
                        .optional(),
                      systemPrompt: z.string().optional(),
                    })
                    .optional(),
                )
                .optional(),
            })
            .optional(),
        )
        .optional(),
      allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
      textChunkLimit: z.number().int().positive().optional(),
      mediaMaxMb: z.number().positive().optional(),
      proxy: z.string().optional(),
      webhookUrl: z.string().optional(),
      webhookSecret: z.string().optional(),
      webhookPath: z.string().optional(),
    })
    .optional(),
  discord: z
    .object({
      enabled: z.boolean().optional(),
      token: z.string().optional(),
      textChunkLimit: z.number().int().positive().optional(),
      slashCommand: z
        .object({
          enabled: z.boolean().optional(),
          name: z.string().optional(),
          sessionPrefix: z.string().optional(),
          ephemeral: z.boolean().optional(),
        })
        .optional(),
      mediaMaxMb: z.number().positive().optional(),
      historyLimit: z.number().int().min(0).optional(),
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
      dm: z
        .object({
          enabled: z.boolean().optional(),
          allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
          groupEnabled: z.boolean().optional(),
          groupChannels: z.array(z.union([z.string(), z.number()])).optional(),
        })
        .optional(),
      guilds: z
        .record(
          z.string(),
          z
            .object({
              slug: z.string().optional(),
              requireMention: z.boolean().optional(),
              reactionNotifications: z
                .enum(["off", "own", "all", "allowlist"])
                .optional(),
              users: z.array(z.union([z.string(), z.number()])).optional(),
              channels: z
                .record(
                  z.string(),
                  z
                    .object({
                      allow: z.boolean().optional(),
                      requireMention: z.boolean().optional(),
                      skills: z.array(z.string()).optional(),
                      enabled: z.boolean().optional(),
                      autoReply: z.boolean().optional(),
                      users: z.array(z.union([z.string(), z.number()])).optional(),
                      systemPrompt: z.string().optional(),
                    })
                    .optional(),
                )
                .optional(),
            })
            .optional(),
        )
        .optional(),
    })
    .optional(),
  slack: z
    .object({
      enabled: z.boolean().optional(),
      botToken: z.string().optional(),
      appToken: z.string().optional(),
      textChunkLimit: z.number().int().positive().optional(),
      mediaMaxMb: z.number().positive().optional(),
      reactionNotifications: z
        .enum(["off", "own", "all", "allowlist"])
        .optional(),
      reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
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
      dm: z
        .object({
          enabled: z.boolean().optional(),
          allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
          groupEnabled: z.boolean().optional(),
          groupChannels: z.array(z.union([z.string(), z.number()])).optional(),
        })
        .optional(),
      channels: z
        .record(
          z.string(),
          z
            .object({
              allow: z.boolean().optional(),
              requireMention: z.boolean().optional(),
              skills: z.array(z.string()).optional(),
              enabled: z.boolean().optional(),
              autoReply: z.boolean().optional(),
              users: z.array(z.union([z.string(), z.number()])).optional(),
              systemPrompt: z.string().optional(),
            })
            .optional(),
        )
        .optional(),
    })
    .optional(),
  signal: z
    .object({
      enabled: z.boolean().optional(),
      account: z.string().optional(),
      httpUrl: z.string().optional(),
      httpHost: z.string().optional(),
      httpPort: z.number().int().positive().optional(),
      cliPath: z.string().optional(),
      autoStart: z.boolean().optional(),
      receiveMode: z
        .union([z.literal("on-start"), z.literal("manual")])
        .optional(),
      ignoreAttachments: z.boolean().optional(),
      ignoreStories: z.boolean().optional(),
      sendReadReceipts: z.boolean().optional(),
      allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
      textChunkLimit: z.number().int().positive().optional(),
      mediaMaxMb: z.number().positive().optional(),
    })
    .optional(),
  imessage: z
    .object({
      enabled: z.boolean().optional(),
      cliPath: z.string().optional(),
      dbPath: z.string().optional(),
      service: z
        .union([z.literal("imessage"), z.literal("sms"), z.literal("auto")])
        .optional(),
      region: z.string().optional(),
      allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
      includeAttachments: z.boolean().optional(),
      mediaMaxMb: z.number().positive().optional(),
      textChunkLimit: z.number().int().positive().optional(),
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
    })
    .optional(),
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
          mode: z.union([z.literal("token"), z.literal("password")]).optional(),
          token: z.string().optional(),
          password: z.string().optional(),
          allowTailscale: z.boolean().optional(),
        })
        .optional(),
      tailscale: z
        .object({
          mode: z
            .union([z.literal("off"), z.literal("serve"), z.literal("funnel")])
            .optional(),
          resetOnExit: z.boolean().optional(),
        })
        .optional(),
      remote: z
        .object({
          url: z.string().optional(),
          token: z.string().optional(),
          password: z.string().optional(),
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
});
