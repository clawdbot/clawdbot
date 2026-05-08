import { z } from "zod";
import { parseByteSize } from "../cli/parse-bytes.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import {
  isValidControlUiChatMessageMaxWidth,
  normalizeControlUiChatMessageMaxWidth,
} from "./control-ui-css.js";
import {
  SilentReplyPolicyConfigSchema,
  SilentReplyRewriteConfigSchema,
} from "./zod-schema.agent-defaults.js";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";
import { AgentsSchema, AudioSchema, BindingsSchema, BroadcastSchema } from "./zod-schema.agents.js";
import { ApprovalsSchema } from "./zod-schema.approvals.js";
import {
  HexColorSchema,
  ModelsConfigSchema,
  SecretInputSchema,
  SecretsConfigSchema,
} from "./zod-schema.core.js";
import { HookMappingSchema, HooksGmailSchema, InternalHooksSchema } from "./zod-schema.hooks.js";
import { ChannelsSchema } from "./zod-schema.providers.js";
import { ProxyConfigSchema } from "./zod-schema.proxy.js";
import { sensitive } from "./zod-schema.sensitive.js";
import {
  CommandsSchema,
  MessagesSchema,
  SessionSchema,
  SessionSendPolicySchema,
} from "./zod-schema.session.js";

const BrowserSnapshotDefaultsSchema = z
  .object({
    mode: z.literal("efficient").optional(),
  })
  .strict()
  .optional();

const NodeHostSchema = z
  .object({
    browserProxy: z
      .object({
        enabled: z.boolean().optional(),
        allowProfiles: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const LegacyCanvasHostSchema = z
  .object({
    enabled: z.boolean().optional(),
    root: z.string().optional(),
    port: z.number().int().positive().optional(),
    liveReload: z.boolean().optional(),
  })
  .strict()
  .optional();

const AccessGroupsSchema = z
  .record(
    z.string().min(1),
    z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("discord.channelAudience"),
          guildId: z.string().min(1),
          channelId: z.string().min(1),
          membership: z.literal("canViewChannel").optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("message.senders"),
          members: z.record(z.string().min(1), z.array(z.string().min(1))),
        })
        .strict(),
    ]),
  )
  .optional();

const MemoryQmdPathSchema = z
  .object({
    path: z.string(),
    name: z.string().optional(),
    pattern: z.string().optional(),
  })
  .strict();

const MemoryQmdSessionSchema = z
  .object({
    enabled: z.boolean().optional(),
    exportDir: z.string().optional(),
    retentionDays: z.number().int().nonnegative().optional(),
  })
  .strict();

const MemoryQmdUpdateSchema = z
  .object({
    interval: z.string().optional(),
    debounceMs: z.number().int().nonnegative().optional(),
    onBoot: z.boolean().optional(),
    startup: z.enum(["off", "idle", "immediate"]).optional(),
    startupDelayMs: z.number().int().nonnegative().optional(),
    waitForBootSync: z.boolean().optional(),
    embedInterval: z.string().optional(),
    commandTimeoutMs: z.number().int().nonnegative().optional(),
    updateTimeoutMs: z.number().int().nonnegative().optional(),
    embedTimeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const MemoryQmdLimitsSchema = z
  .object({
    maxResults: z.number().int().positive().optional(),
    maxSnippetChars: z.number().int().positive().optional(),
    maxInjectedChars: z.number().int().positive().optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const MemoryQmdMcporterSchema = z
  .object({
    enabled: z.boolean().optional(),
    serverName: z.string().optional(),
    startDaemon: z.boolean().optional(),
  })
  .strict();

const LoggingLevelSchema = z.union([
  z.literal("silent"),
  z.literal("fatal"),
  z.literal("error"),
  z.literal("warn"),
  z.literal("info"),
  z.literal("debug"),
  z.literal("trace"),
]);

const MemoryQmdSchema = z
  .object({
    command: z.string().optional(),
    mcporter: MemoryQmdMcporterSchema.optional(),
    searchMode: z.union([z.literal("query"), z.literal("search"), z.literal("vsearch")]).optional(),
    searchTool: z.string().trim().min(1).optional(),
    includeDefaultMemory: z.boolean().optional(),
    paths: z.array(MemoryQmdPathSchema).optional(),
    sessions: MemoryQmdSessionSchema.optional(),
    update: MemoryQmdUpdateSchema.optional(),
    limits: MemoryQmdLimitsSchema.optional(),
    scope: SessionSendPolicySchema.optional(),
  })
  .strict();

const MemorySchema = z
  .object({
    backend: z.union([z.literal("builtin"), z.literal("qmd")]).optional(),
    citations: z.union([z.literal("auto"), z.literal("on"), z.literal("off")]).optional(),
    qmd: MemoryQmdSchema.optional(),
  })
  .strict()
  .optional();

const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Expected http:// or https:// URL");

const ResponsesEndpointUrlFetchShape = {
  allowUrl: z.boolean().optional(),
  urlAllowlist: z.array(z.string()).optional(),
  allowedMimes: z.array(z.string()).optional(),
  maxBytes: z.number().int().positive().optional(),
  maxRedirects: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().optional(),
};

const SkillEntrySchema = z
  .object({
    enabled: z.boolean().optional(),
    apiKey: SecretInputSchema.optional().register(sensitive),
    env: z.record(z.string(), z.string()).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const PluginEntrySchema = z
  .object({
    enabled: z.boolean().optional(),
    hooks: z
      .object({
        allowPromptInjection: z.boolean().optional(),
        allowConversationAccess: z.boolean().optional(),
        timeoutMs: z.number().int().positive().max(600_000).optional(),
        timeouts: z.record(z.string(), z.number().int().positive().max(600_000)).optional(),
      })
      .strict()
      .optional(),
    subagent: z
      .object({
        allowModelOverride: z.boolean().optional(),
        allowedModels: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    llm: z
      .object({
        allowModelOverride: z.boolean().optional(),
        allowedModels: z.array(z.string()).optional(),
        allowAgentIdOverride: z.boolean().optional(),
      })
      .strict()
      .optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const TalkProviderEntrySchema = z
  .object({
    apiKey: SecretInputSchema.optional().register(sensitive),
  })
  .catchall(z.unknown());

const TalkRealtimeSchema = z
  .object({
    provider: z.string().optional(),
    providers: z.record(z.string(), TalkProviderEntrySchema).optional(),
    model: z.string().optional(),
    voice: z.string().optional(),
    mode: z.enum(["realtime", "stt-tts", "transcription"]).optional(),
    transport: z.enum(["webrtc", "provider-websocket", "gateway-relay", "managed-room"]).optional(),
    brain: z.enum(["agent-consult", "direct-tools", "none"]).optional(),
  })
  .strict()
  .superRefine((realtime, ctx) => {
    const provider = normalizeLowercaseStringOrEmpty(realtime.provider ?? "");
    const providers = realtime.providers ? Object.keys(realtime.providers) : [];

    if (provider && providers.length > 0 && !(provider in realtime.providers!)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        message: `talk.realtime.provider must match a key in talk.realtime.providers (missing "${provider}")`,
      });
    }

    if (!provider && providers.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        message:
          "talk.realtime.provider is required when talk.realtime.providers defines multiple providers",
      });
    }
  });

const TalkSchema = z
  .object({
    provider: z.string().optional(),
    providers: z.record(z.string(), TalkProviderEntrySchema).optional(),
    realtime: TalkRealtimeSchema.optional(),
    speechLocale: z.string().optional(),
    interruptOnSpeech: z.boolean().optional(),
    silenceTimeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((talk, ctx) => {
    const provider = normalizeLowercaseStringOrEmpty(talk.provider ?? "");
    const providers = talk.providers ? Object.keys(talk.providers) : [];

    if (provider && providers.length > 0 && !(provider in talk.providers!)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        message: `talk.provider must match a key in talk.providers (missing "${provider}")`,
      });
    }

    if (!provider && providers.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provider"],
        message: "talk.provider is required when talk.providers defines multiple providers",
      });
    }
  });

const McpServerSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    cwd: z.string().optional(),
    workingDirectory: z.string().optional(),
    url: HttpUrlSchema.optional(),
    transport: z.union([z.literal("sse"), z.literal("streamable-http")]).optional(),
    headers: z
      .record(
        z.string(),
        z.union([z.string().register(sensitive), z.number(), z.boolean()]).register(sensitive),
      )
      .optional(),
  })
  .catchall(z.unknown());

const McpConfigSchema = z
  .object({
    servers: z.record(z.string(), McpServerSchema).optional(),
    sessionIdleTtlMs: z.number().finite().min(0).optional(),
  })
  .strict()
  .optional();

const CrestodianSchema = z
  .object({
    rescue: z
      .object({
        enabled: z.union([z.literal("auto"), z.boolean()]).optional(),
        ownerDmOnly: z.boolean().optional(),
        pendingTtlMinutes: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const CommitmentsSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxPerDay: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const OpenClawSchema = z
  .object({
    $schema: z.string().optional(),
    meta: z
      .object({
        lastTouchedVersion: z.string().optional(),
        // Accept any string unchanged (backwards-compatible) and coerce numeric Unix
        // timestamps to ISO strings (agent file edits may write Date.now()).
        lastTouchedAt: z
          .union([
            z.string(),
            z.number().transform((n, ctx) => {
              const d = new Date(n);
              if (Number.isNaN(d.getTime())) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid timestamp" });
                return z.NEVER;
              }
              return d.toISOString();
            }),
          ])
          .optional(),
      })
      .strict()
      .optional(),
    env: z
      .object({
        shellEnv: z
          .object({
            enabled: z.boolean().optional(),
            timeoutMs: z.number().int().nonnegative().optional(),
          })
          .strict()
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
        lastRunMode: z.union([z.literal("local"), z.literal("remote")]).optional(),
      })
      .strict()
      .optional(),
    diagnostics: z
      .object({
        enabled: z.boolean().optional(),
        flags: z.array(z.string()).optional(),
        stuckSessionWarnMs: z.number().int().positive().optional(),
        stuckSessionAbortMs: z.number().int().positive().optional(),
        otel: z
          .object({
            enabled: z.boolean().optional(),
            endpoint: z.string().optional(),
            tracesEndpoint: z.string().optional(),
            metricsEndpoint: z.string().optional(),
            logsEndpoint: z.string().optional(),
            protocol: z.union([z.literal("http/protobuf"), z.literal("grpc")]).optional(),
            headers: z.record(z.string(), z.string()).optional(),
            serviceName: z.string().optional(),
            traces: z.boolean().optional(),
            metrics: z.boolean().optional(),
            logs: z.boolean().optional(),
            sampleRate: z.number().min(0).max(1).optional(),
            flushIntervalMs: z.number().int().nonnegative().optional(),
            captureContent: z
              .union([
                z.boolean(),
                z
                  .object({
                    enabled: z.boolean().optional(),
                    inputMessages: z.boolean().optional(),
                    outputMessages: z.boolean().optional(),
                    toolInputs: z.boolean().optional(),
                    toolOutputs: z.boolean().optional(),
                    systemPrompt: z.boolean().optional(),
                  })
                  .strict(),
              ])
              .optional(),
          })
          .strict()
          .optional(),
        cacheTrace: z
          .object({
            enabled: z.boolean().optional(),
            filePath: z.string().optional(),
            includeMessages: z.boolean().optional(),
            includePrompt: z.boolean().optional(),
            includeSystem: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    logging: z
      .object({
        level: LoggingLevelSchema.optional(),
        file: z.string().optional(),
        maxFileBytes: z.number().int().positive().optional(),
        consoleLevel: LoggingLevelSchema.optional(),
        consoleStyle: z
          .union([z.literal("pretty"), z.literal("compact"), z.literal("json")])
          .optional(),
        redactSensitive: z.union([z.literal("off"), z.literal("tools")]).optional(),
        redactPatterns: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    cli: z
      .object({
        banner: z
          .object({
            taglineMode: z
              .union([z.literal("random"), z.literal("default"), z.literal("off")])
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    crestodian: CrestodianSchema,
    update: z
      .object({
        channel: z.union([z.literal("stable"), z.literal("beta"), z.literal("dev")]).optional(),
        checkOnStart: z.boolean().optional(),
        auto: z
          .object({
            enabled: z.boolean().optional(),
            stableDelayHours: z.number().nonnegative().max(168).optional(),
            stableJitterHours: z.number().nonnegative().max(168).optional(),
            betaCheckIntervalHours: z.number().positive().max(24).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    browser: z
      .object({
        enabled: z.boolean().optional(),
        evaluateEnabled: z.boolean().optional(),
        cdpUrl: z.string().optional(),
        remoteCdpTimeoutMs: z.number().int().nonnegative().optional(),
        remoteCdpHandshakeTimeoutMs: z.number().int().nonnegative().optional(),
        localLaunchTimeoutMs: z.number().int().positive().max(120_000).optional(),
        localCdpReadyTimeoutMs: z.number().int().positive().max(120_000).optional(),
        actionTimeoutMs: z.number().int().positive().optional(),
        color: z.string().optional(),
        executablePath: z.string().optional(),
        headless: z.boolean().optional(),
        noSandbox: z.boolean().optional(),
        attachOnly: z.boolean().optional(),
        cdpPortRangeStart: z.number().int().min(1).max(65535).optional(),
        defaultProfile: z.string().optional(),
        snapshotDefaults: BrowserSnapshotDefaultsSchema,
        ssrfPolicy: z
          .object({
            dangerouslyAllowPrivateNetwork: z.boolean().optional(),
            allowedHostnames: z.array(z.string()).optional(),
            hostnameAllowlist: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        profiles: z
          .record(
            z
              .string()
              .regex(/^[a-z0-9-]+$/, "Profile names must be alphanumeric with hyphens only"),
            z
              .object({
                cdpPort: z.number().int().min(1).max(65535).optional(),
                cdpUrl: z.string().optional(),
                userDataDir: z.string().optional(),
                mcpCommand: z.string().optional(),
                mcpArgs: z.array(z.string()).optional(),
                driver: z
                  .union([z.literal("openclaw"), z.literal("clawd"), z.literal("existing-session")])
                  .optional(),
                headless: z.boolean().optional(),
                executablePath: z.string().optional(),
                attachOnly: z.boolean().optional(),
                color: HexColorSchema,
              })
              .strict()
              .refine(
                (value) => value.driver === "existing-session" || value.cdpPort || value.cdpUrl,
                {
                  message: "Profile must set cdpPort or cdpUrl",
                },
              )
              .refine((value) => value.driver === "existing-session" || !value.userDataDir, {
                message: 'Profile userDataDir is only supported with driver="existing-session"',
              }),
          )
          .optional(),
        extraArgs: z.array(z.string()).optional(),
        tabCleanup: z
          .object({
            enabled: z.boolean().optional(),
            idleMinutes: z.number().int().nonnegative().optional(),
            maxTabsPerSession: z.number().int().nonnegative().optional(),
            sweepMinutes: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    ui: z
      .object({
        seamColor: HexColorSchema.optional(),
        assistant: z
          .object({
            name: z.string().max(50).optional(),
            avatar: z.string().max(2_000_000).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    secrets: SecretsConfigSchema,
    auth: z
      .object({
        profiles: z
          .record(
            z.string(),
            z
              .object({
                provider: z.string(),
                mode: z.union([
                  z.literal("api_key"),
                  z.literal("aws-sdk"),
                  z.literal("oauth"),
                  z.literal("token"),
                ]),
                email: z.string().optional(),
                displayName: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
        order: z.record(z.string(), z.array(z.string())).optional(),
        cooldowns: z
          .object({
            billingBackoffHours: z.number().positive().optional(),
            billingBackoffHoursByProvider: z.record(z.string(), z.number().positive()).optional(),
            billingMaxHours: z.number().positive().optional(),
            authPermanentBackoffMinutes: z.number().positive().optional(),
            authPermanentMaxMinutes: z.number().positive().optional(),
            failureWindowHours: z.number().positive().optional(),
            overloadedProfileRotations: z.number().int().nonnegative().optional(),
            overloadedBackoffMs: z.number().int().nonnegative().optional(),
            rateLimitedProfileRotations: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    accessGroups: AccessGroupsSchema,
    acp: z
      .object({
        enabled: z.boolean().optional(),
        dispatch: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
        backend: z.string().optional(),
        defaultAgent: z.string().optional(),
        allowedAgents: z.array(z.string()).optional(),
        maxConcurrentSessions: z.number().int().positive().optional(),
        stream: z
          .object({
            coalesceIdleMs: z.number().int().nonnegative().optional(),
            maxChunkChars: z.number().int().positive().optional(),
            repeatSuppression: z.boolean().optional(),
            deliveryMode: z.union([z.literal("live"), z.literal("final_only")]).optional(),
            hiddenBoundarySeparator: z
              .union([
                z.literal("none"),
                z.literal("space"),
                z.literal("newline"),
                z.literal("paragraph"),
              ])
              .optional(),
            maxOutputChars: z.number().int().positive().optional(),
            maxSessionUpdateChars: z.number().int().positive().optional(),
            tagVisibility: z.record(z.string(), z.boolean()).optional(),
          })
          .strict()
          .optional(),
        runtime: z
          .object({
            ttlMinutes: z.number().int().positive().optional(),
            installCommand: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    models: ModelsConfigSchema,
    nodeHost: NodeHostSchema,
    agents: AgentsSchema,
    tools: ToolsSchema,
    bindings: BindingsSchema,
    broadcast: BroadcastSchema,
    audio: AudioSchema,
    media: z
      .object({
        preserveFilenames: z.boolean().optional(),
        ttlHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 7)
          .optional(),
      })
      .strict()
      .optional(),
    messages: MessagesSchema,
    commands: CommandsSchema,
    approvals: ApprovalsSchema,
    session: SessionSchema,
    cron: z
      .object({
        enabled: z.boolean().optional(),
        store: z.string().optional(),
        maxConcurrentRuns: z.number().int().positive().optional(),
        retry: z
          .object({
            maxAttempts: z.number().int().min(0).max(10).optional(),
            backoffMs: z.array(z.number().int().nonnegative()).min(1).max(10).optional(),
            retryOn: z
              .array(z.enum(["rate_limit", "overloaded", "network", "timeout", "server_error"]))
              .min(1)
              .optional(),
          })
          .strict()
          .optional(),
        webhook: HttpUrlSchema.optional(),
        webhookToken: SecretInputSchema.optional().register(sensitive),
        sessionRetention: z.union([z.string(), z.literal(false)]).optional(),
        runLog: z
          .object({
            maxBytes: z.union([z.string(), z.number()]).optional(),
            keepLines: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        failureAlert: z
          .object({
            enabled: z.boolean().optional(),
            after: z.number().int().min(1).optional(),
            cooldownMs: z.number().int().min(0).optional(),
            includeSkipped: z.boolean().optional(),
            mode: z.enum(["announce", "webhook"]).optional(),
            accountId: z.string().optional(),
          })
          .strict()
          .optional(),
        failureDestination: z
          .object({
            channel: z.string().optional(),
            to: z.string().optional(),
            accountId: z.string().optional(),
            mode: z.enum(["announce", "webhook"]).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .superRefine((val, ctx) => {
        if (val.sessionRetention !== undefined && val.sessionRetention !== false) {
          try {
            parseDurationMs(normalizeStringifiedOptionalString(val.sessionRetention) ?? "", {
              defaultUnit: "h",
            });
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["sessionRetention"],
              message: "invalid duration (use ms, s, m, h, d)",
            });
          }
        }
        if (val.runLog?.maxBytes !== undefined) {
          try {
            parseByteSize(normalizeStringifiedOptionalString(val.runLog.maxBytes) ?? "", {
              defaultUnit: "b",
            });
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["runLog", "maxBytes"],
              message: "invalid size (use b, kb, mb, gb, tb)",
            });
          }
        }
      })
      .optional(),
    commitments: CommitmentsSchema,
    hooks: z
      .object({
        enabled: z.boolean().optional(),
        path: z.string().optional(),
        token: z.string().optional().register(sensitive),
        defaultSessionKey: z.string().optional(),
        allowRequestSessionKey: z.boolean().optional(),
        allowedSessionKeyPrefixes: z.array(z.string()).optional(),
        allowedAgentIds: z.array(z.string()).optional(),
        maxBodyBytes: z.number().int().positive().optional(),
        presets: z.array(z.string()).optional(),
        transformsDir: z.string().optional(),
        mappings: z.array(HookMappingSchema).optional(),
        gmail: HooksGmailSchema,
        internal: InternalHooksSchema,
      })
      .strict()
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
          .strict()
          .optional(),
        whatsapp: z
          .object({
            keepAliveIntervalMs: z.number().int().positive().optional(),
            connectTimeoutMs: z.number().int().positive().optional(),
            defaultQueryTimeoutMs: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    channels: ChannelsSchema,
    discovery: z
      .object({
        wideArea: z
          .object({
            enabled: z.boolean().optional(),
            domain: z.string().optional(),
          })
          .strict()
          .optional(),
        mdns: z
          .object({
            mode: z.enum(["off", "minimal", "full"]).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    talk: TalkSchema.optional(),
    gateway: z
      .object({
        port: z.number().int().positive().optional(),
        mode: z.union([z.literal("local"), z.literal("remote")]).optional(),
        bind: z
          .union([
            z.literal("auto"),
            z.literal("lan"),
            z.literal("loopback"),
            z.literal("custom"),
            z.literal("tailnet"),
          ])
          .optional(),
        customBindHost: z.string().optional(),
        controlUi: z
          .object({
            enabled: z.boolean().optional(),
            basePath: z.string().optional(),
            root: z.string().optional(),
            embedSandbox: z
              .union([z.literal("strict"), z.literal("scripts"), z.literal("trusted")])
              .optional(),
            allowExternalEmbedUrls: z.boolean().optional(),
            chatMessageMaxWidth: z
              .string()
              .transform((value) => normalizeControlUiChatMessageMaxWidth(value))
              .refine((value) => isValidControlUiChatMessageMaxWidth(value), {
                message:
                  "Expected a CSS width value such as 960px, 82%, min(1280px, 82%), or calc(100% - 2rem)",
              })
              .optional(),
            allowedOrigins: z.array(z.string()).optional(),
            dangerouslyAllowHostHeaderOriginFallback: z.boolean().optional(),
            allowInsecureAuth: z.boolean().optional(),
            dangerouslyDisableDeviceAuth: z.boolean().optional(),
          })
          .strict()
          .optional(),
        auth: z
          .object({
            mode: z
              .union([
                z.literal("none"),
                z.literal("token"),
                z.literal("password"),
                z.literal("trusted-proxy"),
              ])
              .optional(),
            token: SecretInputSchema.optional().register(sensitive),
            password: SecretInputSchema.optional().register(sensitive),
            allowTailscale: z.boolean().optional(),
            rateLimit: z
              .object({
                maxAttempts: z.number().optional(),
                windowMs: z.number().optional(),
                lockoutMs: z.number().optional(),
                exemptLoopback: z.boolean().optional(),
              })
              .strict()
              .optional(),
            trustedProxy: z
              .object({
                userHeader: z.string().min(1, "userHeader is required for trusted-proxy mode"),
                requiredHeaders: z.array(z.string()).optional(),
                allowUsers: z.array(z.string()).optional(),
                allowLoopback: z.boolean().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        trustedProxies: z.array(z.string()).optional(),
        allowRealIpFallback: z.boolean().optional(),
        tools: z
          .object({
            deny: z.array(z.string()).optional(),
            allow: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        webchat: z
          .object({
            chatHistoryMaxChars: z.number().int().positive().max(500_000).optional(),
          })
          .strict()
          .optional(),
        handshakeTimeoutMs: z.number().int().min(1).optional(),
        channelHealthCheckMinutes: z.number().int().min(0).optional(),
        channelStaleEventThresholdMinutes: z.number().int().min(1).optional(),
        channelMaxRestartsPerHour: z.number().int().min(1).optional(),
        tailscale: z
          .object({
            mode: z.union([z.literal("off"), z.literal("serve"), z.literal("funnel")]).optional(),
            resetOnExit: z.boolean().optional(),
          })
          .strict()
          .optional(),
        remote: z
          .object({
            url: z.string().optional(),
            transport: z.union([z.literal("ssh"), z.literal("direct")]).optional(),
            token: SecretInputSchema.optional().register(sensitive),
            password: SecretInputSchema.optional().register(sensitive),
            tlsFingerprint: z.string().optional(),
            sshTarget: z.string().optional(),
            sshIdentity: z.string().optional(),
          })
          .strict()
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
            deferralTimeoutMs: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        tls: z
          .object({
            enabled: z.boolean().optional(),
            autoGenerate: z.boolean().optional(),
            certPath: z.string().optional(),
            keyPath: z.string().optional(),
            caPath: z.string().optional(),
          })
          .optional(),
        http: z
          .object({
            endpoints: z
              .object({
                chatCompletions: z
                  .object({
                    enabled: z.boolean().optional(),
                    maxBodyBytes: z.number().int().positive().optional(),
                    maxImageParts: z.number().int().nonnegative().optional(),
                    maxTotalImageBytes: z.number().int().positive().optional(),
                    images: z
                      .object({
                        ...ResponsesEndpointUrlFetchShape,
                      })
                      .strict()
                      .optional(),
                  })
                  .strict()
                  .optional(),
                responses: z
                  .object({
                    enabled: z.boolean().optional(),
                    maxBodyBytes: z.number().int().positive().optional(),
                    maxUrlParts: z.number().int().nonnegative().optional(),
                    files: z
                      .object({
                        ...ResponsesEndpointUrlFetchShape,
                        maxChars: z.number().int().positive().optional(),
                        pdf: z
                          .object({
                            maxPages: z.number().int().positive().optional(),
                            maxPixels: z.number().int().positive().optional(),
                            minTextChars: z.number().int().nonnegative().optional(),
                          })
                          .strict()
                          .optional(),
                      })
                      .strict()
                      .optional(),
                    images: z
                      .object({
                        ...ResponsesEndpointUrlFetchShape,
                      })
                      .strict()
                      .optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
            securityHeaders: z
              .object({
                strictTransportSecurity: z.union([z.string(), z.literal(false)]).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        push: z
          .object({
            apns: z
              .object({
                relay: z
                  .object({
                    baseUrl: z.string().optional(),
                    timeoutMs: z.number().int().positive().optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        nodes: z
          .object({
            browser: z
              .object({
                mode: z
                  .union([z.literal("auto"), z.literal("manual"), z.literal("off")])
                  .optional(),
                node: z.string().optional(),
              })
              .strict()
              .optional(),
            pairing: z
              .object({
                autoApproveCidrs: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
            allowCommands: z.array(z.string()).optional(),
            denyCommands: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .superRefine((gateway, ctx) => {
        const effectiveHealthCheckMinutes = gateway.channelHealthCheckMinutes ?? 5;
        if (
          gateway.channelStaleEventThresholdMinutes != null &&
          effectiveHealthCheckMinutes !== 0 &&
          gateway.channelStaleEventThresholdMinutes < effectiveHealthCheckMinutes
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["channelStaleEventThresholdMinutes"],
            message:
              "channelStaleEventThresholdMinutes should be >= channelHealthCheckMinutes to avoid delayed stale detection",
          });
        }
      })
      .optional(),
    memory: MemorySchema,
    mcp: McpConfigSchema,
    skills: z
      .object({
        allowBundled: z.array(z.string()).optional(),
        load: z
          .object({
            extraDirs: z.array(z.string()).optional(),
            watch: z.boolean().optional(),
            watchDebounceMs: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        install: z
          .object({
            preferBrew: z.boolean().optional(),
            nodeManager: z
              .union([z.literal("npm"), z.literal("pnpm"), z.literal("yarn"), z.literal("bun")])
              .optional(),
          })
          .strict()
          .optional(),
        limits: z
          .object({
            maxCandidatesPerRoot: z.number().int().min(1).optional(),
            maxSkillsLoadedPerSource: z.number().int().min(1).optional(),
            maxSkillsInPrompt: z.number().int().min(0).optional(),
            maxSkillsPromptChars: z.number().int().min(0).optional(),
            maxSkillFileBytes: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        entries: z.record(z.string(), SkillEntrySchema).optional(),
      })
      .strict()
      .optional(),
    plugins: z
      .object({
        enabled: z.boolean().optional(),
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
        load: z
          .object({
            paths: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        slots: z
          .object({
            memory: z.string().optional(),
            contextEngine: z.string().optional(),
          })
          .strict()
          .optional(),
        entries: z.record(z.string(), PluginEntrySchema).optional(),
        bundledDiscovery: z.enum(["compat", "allowlist"]).optional(),
      })
      .strict()
      .optional(),
    canvasHost: LegacyCanvasHostSchema,
    surfaces: z
      .record(
        z.string(),
        z
          .object({
            silentReply: SilentReplyPolicyConfigSchema.optional(),
            silentReplyRewrite: SilentReplyRewriteConfigSchema.optional(),
          })
          .strict(),
      )
      .optional(),
    proxy: ProxyConfigSchema,
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const agents = cfg.agents?.list ?? [];
    if (agents.length === 0) {
      return;
    }
    const agentIds = new Set(agents.map((agent) => agent.id));

    const broadcast = cfg.broadcast;
    if (!broadcast) {
      return;
    }

    for (const [peerId, ids] of Object.entries(broadcast)) {
      if (peerId === "strategy") {
        continue;
      }
      if (!Array.isArray(ids)) {
        continue;
      }
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
