import { normalizeStringifiedOptionalString } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import { parseDurationMs } from "../cli/parse-duration.js";
import { SilentReplyPolicyConfigSchema } from "./zod-schema.agent-defaults.js";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";
import { AgentsSchema, BindingsSchema, BroadcastSchema } from "./zod-schema.agents.js";
import { ApprovalsSchema } from "./zod-schema.approvals.js";
import { ChannelsSchema } from "./zod-schema.channels-config.js";
import { CloudWorkersConfigSchema } from "./zod-schema.cloud-workers.js";
import {
  HexColorSchema,
  ModelsConfigSchema,
  SecretInputSchema,
  SecretsConfigSchema,
} from "./zod-schema.core.js";
import { GatewayConfigSchema } from "./zod-schema.gateway.js";
import { HookMappingSchema, HooksGmailSchema, InternalHooksSchema } from "./zod-schema.hooks.js";
import { BrowserSnapshotDefaultsSchema } from "./zod-schema.node-host.js";
import { ProxyConfigSchema } from "./zod-schema.proxy.js";
import {
  AccessGroupsSchema,
  CommitmentsSchema,
  LoggingLevelSchema,
  MarketplacesSchema,
  McpConfigSchema,
  MemorySchema,
  NodeHostSchema,
  PluginEntrySchema,
  SecuritySchema,
  SkillEntrySchema,
  SystemAgentSchema,
  TalkSchema,
} from "./zod-schema.root-support.js";
import { sensitive } from "./zod-schema.sensitive.js";
import { CommandsSchema, MessagesSchema, SessionSchema } from "./zod-schema.session.js";

export const OpenClawSchemaShape = {
  $schema: z.string().optional(),
  meta: z
    .strictObject({
      lastTouchedVersion: z.string().optional(),
      // Accept any string unchanged (backwards-compatible) and coerce numeric Unix
      // timestamps to ISO strings (agent file edits may write Date.now()).
      lastTouchedAt: z
        .union([
          z.string(),
          z
            .number()
            .transform((n, ctx) => {
              const d = new Date(n);
              if (Number.isNaN(d.getTime())) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid timestamp" });
                return z.NEVER;
              }
              return d.toISOString();
            })
            .pipe(z.string()),
        ])
        .optional(),
      migrations: z
        .strictObject({
          modelPolicyAllowlist: z.literal(true).optional(),
        })
        .optional(),
    })
    .optional(),
  env: z
    .object({
      shellEnv: z
        .strictObject({
          enabled: z.boolean().optional(),
          timeoutMs: z.number().int().nonnegative().optional(),
        })
        .optional(),
      vars: z.record(z.string(), z.string()).optional(),
    })
    .catchall(z.string())
    .optional(),
  wizard: z
    .strictObject({
      accessMode: z.union([z.literal("full"), z.literal("guarded")]).optional(),
      appRecommendations: z.boolean().optional(),
      lastRunAt: z.string().optional(),
      lastRunVersion: z.string().optional(),
      lastRunCommit: z.string().optional(),
      lastRunCommand: z.string().optional(),
      lastRunMode: z.union([z.literal("local"), z.literal("remote")]).optional(),
      localModelLeanAutoModel: z.string().optional(),
      securityAcknowledgedAt: z.string().optional(),
    })
    .optional(),
  diagnostics: z
    .strictObject({
      enabled: z.boolean().optional(),
      flags: z.array(z.string()).optional(),
      otel: z
        .strictObject({
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
          logsExporter: z
            .union([z.literal("otlp"), z.literal("stdout"), z.literal("both")])
            .optional(),
          sampleRate: z.number().min(0).max(1).optional(),
          flushIntervalMs: z.number().int().nonnegative().optional(),
          captureContent: z
            .union([
              z.boolean(),
              z.strictObject({
                enabled: z.boolean().optional(),
                inputMessages: z.boolean().optional(),
                outputMessages: z.boolean().optional(),
                toolInputs: z.boolean().optional(),
                toolOutputs: z.boolean().optional(),
                systemPrompt: z.boolean().optional(),
                toolDefinitions: z.boolean().optional(),
              }),
            ])
            .optional(),
        })
        .optional(),
      cacheTrace: z
        .strictObject({
          enabled: z.boolean().optional(),
          filePath: z.string().optional(),
          includeMessages: z.boolean().optional(),
          includePrompt: z.boolean().optional(),
          includeSystem: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  audit: z
    .strictObject({
      enabled: z.boolean().optional(),
      messages: z.union([z.literal("off"), z.literal("direct"), z.literal("all")]).optional(),
    })
    .optional(),
  logging: z
    .strictObject({
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
    .optional(),
  cli: z
    .strictObject({
      banner: z
        .strictObject({
          taglineMode: z
            .union([z.literal("random"), z.literal("default"), z.literal("off")])
            .optional(),
        })
        .optional(),
    })
    .optional(),
  systemAgent: SystemAgentSchema,
  update: z
    .strictObject({
      channel: z
        .union([
          z.literal("stable"),
          z.literal("extended-stable"),
          z.literal("beta"),
          z.literal("dev"),
        ])
        .optional(),
      checkOnStart: z.boolean().optional(),
      auto: z
        .strictObject({
          enabled: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  browser: z
    .strictObject({
      enabled: z.boolean().optional(),
      allowSystemProfileImport: z.boolean().optional(),
      evaluateEnabled: z.boolean().optional(),
      cdpUrl: z.string().optional(),
      color: z.string().optional(),
      executablePath: z.string().optional(),
      headless: z.boolean().optional(),
      noSandbox: z.boolean().optional(),
      attachOnly: z.boolean().optional(),
      defaultProfile: z.string().optional(),
      snapshotDefaults: BrowserSnapshotDefaultsSchema,
      ssrfPolicy: z
        .strictObject({
          dangerouslyAllowPrivateNetwork: z.boolean().optional(),
          allowedHostnames: z.array(z.string()).optional(),
          hostnameAllowlist: z.array(z.string()).optional(),
        })
        .optional(),
      profiles: z
        .record(
          z.string().regex(/^[a-z0-9-]+$/, "Profile names must be alphanumeric with hyphens only"),
          z
            .strictObject({
              cdpPort: z.number().int().min(1).max(65535).optional(),
              cdpUrl: z.string().optional(),
              userDataDir: z.string().optional(),
              mcpCommand: z.string().optional(),
              mcpArgs: z.array(z.string()).optional(),
              driver: z
                .union([
                  z.literal("openclaw"),
                  z.literal("clawd"),
                  z.literal("existing-session"),
                  z.literal("extension"),
                ])
                .optional(),
              headless: z.boolean().optional(),
              executablePath: z.string().optional(),
              attachOnly: z.boolean().optional(),
              color: HexColorSchema,
            })
            .refine(
              (value) =>
                value.driver === "existing-session" ||
                value.driver === "extension" ||
                value.cdpPort ||
                value.cdpUrl,
              {
                message: "Profile must set cdpPort or cdpUrl",
              },
            )
            .refine((value) => value.driver === "existing-session" || !value.userDataDir, {
              message: 'Profile userDataDir is only supported with driver="existing-session"',
            })
            .refine((value) => value.driver !== "extension" || !value.cdpUrl, {
              message:
                'Profile cdpUrl is not supported with driver="extension" (the relay owns the endpoint)',
            }),
        )
        .optional(),
      extraArgs: z.array(z.string()).optional(),
      tabCleanup: z
        .strictObject({
          enabled: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  ui: z
    .strictObject({
      seamColor: HexColorSchema.optional(),
      assistant: z
        .strictObject({
          name: z.string().max(50).optional(),
          avatar: z.string().max(2_000_000).optional(),
        })
        .optional(),
      // Operator display prefs. Canonical here (agent-writable via approval,
      // synced across devices); the Control UI mirrors them into local
      // storage for instant boot and offline fallback.
      prefs: z
        .strictObject({
          theme: z
            .union([z.literal("claw"), z.literal("knot"), z.literal("dash"), z.literal("custom")])
            .optional(),
          themeMode: z
            .union([z.literal("light"), z.literal("dark"), z.literal("system")])
            .optional(),
          textScale: z
            .union([z.literal(90), z.literal(100), z.literal(110), z.literal(125), z.literal(140)])
            .optional(),
          locale: z.string().max(20).optional(),
          chatShowThinking: z.boolean().optional(),
          chatShowToolCalls: z.boolean().optional(),
          chatPersistCommentary: z.boolean().optional(),
          chatSendShortcut: z.union([z.literal("enter"), z.literal("modifier-enter")]).optional(),
          chatFollowUpMode: z.union([z.literal("steer"), z.literal("queue")]).optional(),
          sidebarEntries: z.array(z.string()).optional(),
          sidebarLiveActivity: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  secrets: SecretsConfigSchema,
  marketplaces: MarketplacesSchema,
  auth: z
    .strictObject({
      profiles: z
        .record(
          z.string(),
          z.strictObject({
            provider: z.string(),
            mode: z.union([
              z.literal("api_key"),
              z.literal("aws-sdk"),
              z.literal("oauth"),
              z.literal("token"),
            ]),
            email: z.string().optional(),
            displayName: z.string().optional(),
          }),
        )
        .optional(),
      order: z.record(z.string(), z.array(z.string())).optional(),
    })
    .optional(),
  accessGroups: AccessGroupsSchema,
  acp: z
    .strictObject({
      enabled: z.boolean().optional(),
      dispatch: z
        .strictObject({
          enabled: z.boolean().optional(),
        })
        .optional(),
      backend: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      defaultAgent: z.string().optional(),
      allowedAgents: z.array(z.string()).optional(),
      stream: z
        .strictObject({
          repeatSuppression: z.boolean().optional(),
          deliveryMode: z.union([z.literal("live"), z.literal("final_only")]).optional(),
          tagVisibility: z.record(z.string(), z.boolean()).optional(),
        })
        .optional(),
      runtime: z
        .strictObject({
          installCommand: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  models: ModelsConfigSchema,
  nodeHost: NodeHostSchema,
  agents: AgentsSchema,
  tools: ToolsSchema,
  security: SecuritySchema,
  bindings: BindingsSchema,
  broadcast: BroadcastSchema,
  media: z
    .strictObject({
      preserveFilenames: z.boolean().optional(),
      ttlHours: z
        .number()
        .int()
        .min(1)
        .max(24 * 7)
        .optional(),
    })
    .optional(),
  messages: MessagesSchema,
  commands: CommandsSchema,
  approvals: ApprovalsSchema,
  session: SessionSchema,
  cron: z
    .strictObject({
      enabled: z.boolean().optional(),
      store: z.string().optional(),
      triggers: z
        .strictObject({
          enabled: z.boolean().optional(),
        })
        .optional(),
      webhookToken: SecretInputSchema.optional().register(sensitive),
      sessionRetention: z.union([z.string(), z.literal(false)]).optional(),
      failureAlert: z
        .strictObject({
          enabled: z.boolean().optional(),
          after: z.number().int().min(1).optional(),
          cooldownMs: z.number().int().min(0).optional(),
          includeSkipped: z.boolean().optional(),
          mode: z.enum(["announce", "webhook"]).optional(),
          accountId: z.string().optional(),
        })
        .optional(),
      failureDestination: z
        .strictObject({
          channel: z.string().optional(),
          to: z.string().optional(),
          accountId: z.string().optional(),
          mode: z.enum(["announce", "webhook"]).optional(),
        })
        .optional(),
    })
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
    })
    .optional(),
  transcripts: z
    .strictObject({
      enabled: z.boolean().optional(),
      autoStart: z
        .array(
          z.strictObject({
            providerId: z.string().min(1),
            sessionId: z.string().min(1).optional(),
            title: z.string().min(1).optional(),
            accountId: z.string().min(1).optional(),
            guildId: z.string().min(1).optional(),
            channelId: z.string().min(1).optional(),
            meetingUrl: z.string().min(1).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  commitments: CommitmentsSchema,
  hooks: z
    .strictObject({
      enabled: z.boolean().optional(),
      path: z.string().optional(),
      token: z.string().optional().register(sensitive),
      defaultSessionKey: z.string().optional(),
      allowRequestSessionKey: z.boolean().optional(),
      allowedSessionKeyPrefixes: z.array(z.string()).optional(),
      allowedAgentIds: z.array(z.string()).optional(),
      presets: z.array(z.string()).optional(),
      transformsDir: z.string().optional(),
      mappings: z.array(HookMappingSchema).optional(),
      gmail: HooksGmailSchema,
      internal: InternalHooksSchema,
    })
    .optional(),
  web: z
    .strictObject({
      enabled: z.boolean().optional(),
    })
    .optional(),
  channels: ChannelsSchema,
  discovery: z
    .strictObject({
      wideArea: z
        .strictObject({
          enabled: z.boolean().optional(),
          domain: z.string().optional(),
        })
        .optional(),
      mdns: z
        .strictObject({
          mode: z.enum(["off", "minimal", "full"]).optional(),
        })
        .optional(),
    })
    .optional(),
  talk: TalkSchema.optional(),
  gateway: GatewayConfigSchema,
  cloudWorkers: CloudWorkersConfigSchema,
  memory: MemorySchema,
  mcp: McpConfigSchema,
  skills: z
    .strictObject({
      allowBundled: z.array(z.string()).optional(),
      load: z
        .strictObject({
          extraDirs: z.array(z.string()).optional(),
          allowSymlinkTargets: z.array(z.string()).optional(),
          watch: z.boolean().optional(),
          watchDebounceMs: z.number().int().min(0).optional(),
        })
        .optional(),
      install: z
        .strictObject({
          preferBrew: z.boolean().optional(),
          nodeManager: z
            .union([z.literal("npm"), z.literal("pnpm"), z.literal("yarn"), z.literal("bun")])
            .optional(),
          allowUploadedArchives: z.boolean().optional(),
        })
        .optional(),
      limits: z
        .strictObject({
          maxCandidatesPerRoot: z.number().int().min(1).optional(),
          maxSkillsLoadedPerSource: z.number().int().min(1).optional(),
          maxSkillsInPrompt: z.number().int().min(0).optional(),
          maxSkillsPromptChars: z.number().int().min(0).optional(),
          maxSkillFileBytes: z.number().int().min(0).optional(),
        })
        .optional(),
      workshop: z
        .strictObject({
          autonomous: z
            .strictObject({
              enabled: z.boolean().optional(),
            })
            .optional(),
          approvalPolicy: z.union([z.literal("pending"), z.literal("auto")]).optional(),
          allowSymlinkTargetWrites: z.boolean().optional(),
          maxPending: z.number().int().min(1).optional(),
          maxSkillBytes: z.number().int().min(1).optional(),
        })
        .optional(),
      entries: z.record(z.string(), SkillEntrySchema).optional(),
    })
    .optional(),
  plugins: z
    .strictObject({
      enabled: z.boolean().optional(),
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
      load: z
        .strictObject({
          paths: z.array(z.string()).optional(),
        })
        .optional(),
      slots: z
        .strictObject({
          memory: z.string().optional(),
          contextEngine: z.string().optional(),
        })
        .optional(),
      entries: z.record(z.string(), PluginEntrySchema).optional(),
      bundledDiscovery: z.enum(["compat", "allowlist"]).optional(),
    })
    .optional(),
  surfaces: z
    .record(
      z.string(),
      z.strictObject({
        silentReply: SilentReplyPolicyConfigSchema.optional(),
      }),
    )
    .optional(),
  proxy: ProxyConfigSchema,
};
