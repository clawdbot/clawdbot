import { isHttpsUrl, isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import type { GatewayRemoteConfig } from "./types.gateway.js";
import { MemorySearchSchema } from "./zod-schema.agent-runtime.js";
import { SecretInputSchema } from "./zod-schema.core.js";
import { NodeHostAgentRunsSchema } from "./zod-schema.node-host.js";
import { sensitive } from "./zod-schema.sensitive.js";
import { SessionSendPolicySchema } from "./zod-schema.session.js";

type ConfigSchemaShape<T extends object> = {
  [Key in keyof T]-?: z.ZodType<T[Key]>;
};

const GatewayRemoteSchemaShape = {
  url: z.string().optional(),

  transport: z.union([z.literal("ssh"), z.literal("direct")]).optional(),

  remotePort: z.number().int().min(1).max(65_535).optional(),

  token: SecretInputSchema.optional().register(sensitive),

  password: SecretInputSchema.optional().register(sensitive),
  tlsFingerprint: z.string().optional(),
  sshTarget: z.string().optional(),
  sshIdentity: z.string().optional(),
  sshHostKeyPolicy: z.union([z.literal("strict"), z.literal("openssh")]).optional(),
} satisfies ConfigSchemaShape<GatewayRemoteConfig>;

export const GatewayRemoteConfigSchema = z.strictObject(GatewayRemoteSchemaShape).optional();

export const TailscaleServiceNameSchema = z
  .string()
  .regex(/^svc:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, {
    message:
      'Tailscale serviceName must use the "svc:<dns-label>" format, for example "svc:openclaw"',
  });

export const SecuritySchema = z
  .strictObject({
    audit: z
      .strictObject({
        suppressions: z
          .array(
            z.strictObject({
              checkId: z.string().min(1),
              titleIncludes: z.string().min(1).optional(),
              detailIncludes: z.string().min(1).optional(),
              reason: z.string().min(1).optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    installPolicy: z
      .strictObject({
        enabled: z.boolean().optional(),
        targets: z
          .array(z.union([z.literal("skill"), z.literal("plugin")]))
          .min(1)
          .optional(),
        exec: z
          .strictObject({
            source: z.literal("exec"),
            command: z.string().min(1),
            args: z.array(z.string()).optional(),
            timeoutMs: z.number().int().min(1).optional(),
            noOutputTimeoutMs: z.number().int().min(1).optional(),
            maxOutputBytes: z.number().int().min(1).optional(),
            env: z.record(z.string(), z.string().register(sensitive)).optional(),
            passEnv: z.array(z.string()).optional(),
            trustedDirs: z.array(z.string()).optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .optional();

export const AccessGroupsSchema = z
  .record(
    z.string().min(1),
    z.discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("discord.channelAudience"),
        guildId: z.string().min(1),
        channelId: z.string().min(1),
        membership: z.literal("canViewChannel").optional(),
      }),
      z.strictObject({
        type: z.literal("message.senders"),
        members: z.record(z.string().min(1), z.array(z.string().min(1))),
      }),
    ]),
  )
  .optional();

const MemoryQmdPathSchema = z.strictObject({
  path: z.string(),
  name: z.string().optional(),
  pattern: z.string().optional(),
});

const MemoryQmdSessionSchema = z.strictObject({
  enabled: z.boolean().optional(),
  exportDir: z.string().optional(),
  retentionDays: z.number().int().nonnegative().optional(),
});

const MemoryQmdLimitsSchema = z.strictObject({
  maxResults: z.number().int().positive().optional(),
  maxSnippetChars: z.number().int().positive().optional(),
  maxInjectedChars: z.number().int().positive().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
});

export const LoggingLevelSchema = z.union([
  z.literal("silent"),
  z.literal("fatal"),
  z.literal("error"),
  z.literal("warn"),
  z.literal("info"),
  z.literal("debug"),
  z.literal("trace"),
]);

const MemoryQmdSchema = z.strictObject({
  command: z.string().optional(),
  searchMode: z.union([z.literal("query"), z.literal("search"), z.literal("vsearch")]).optional(),
  rerank: z.boolean().optional(),
  searchTool: z.string().trim().min(1).optional(),
  includeDefaultMemory: z.boolean().optional(),
  paths: z.array(MemoryQmdPathSchema).optional(),
  sessions: MemoryQmdSessionSchema.optional(),
  limits: MemoryQmdLimitsSchema.optional(),
  scope: SessionSendPolicySchema.optional(),
});

export const MemorySchema = z
  .strictObject({
    backend: z.union([z.literal("builtin"), z.literal("qmd")]).optional(),
    citations: z.union([z.literal("auto"), z.literal("on"), z.literal("off")]).optional(),
    search: MemorySearchSchema,
    qmd: MemoryQmdSchema.optional(),
  })
  .optional();

const HttpUrlSchema = z.string().url().refine(isHttpUrl, "Expected http:// or https:// URL");

const McpOAuthClientMetadataUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return isHttpsUrl(url) && url.pathname !== "/";
  }, "Expected https:// URL with a non-root pathname");

export const ResponsesEndpointUrlFetchShape = {
  allowUrl: z.boolean().optional(),
  urlAllowlist: z.array(z.string()).optional(),
  allowedMimes: z.array(z.string()).optional(),
  maxBytes: z.number().int().positive().optional(),
  maxRedirects: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().optional(),
};

export const SkillEntrySchema = z.strictObject({
  enabled: z.boolean().optional(),
  apiKey: SecretInputSchema.optional().register(sensitive),
  env: z.record(z.string(), z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const PluginEntrySchema = z.strictObject({
  enabled: z.boolean().optional(),
  hooks: z
    .strictObject({
      allowPromptInjection: z.boolean().optional(),
      allowConversationAccess: z.boolean().optional(),
      timeoutMs: z.number().int().positive().max(600_000).optional(),
      timeouts: z.record(z.string(), z.number().int().positive().max(600_000)).optional(),
    })
    .optional(),
  subagent: z
    .strictObject({
      allowModelOverride: z.boolean().optional(),
      allowedModels: z.array(z.string()).optional(),
    })
    .optional(),
  llm: z
    .strictObject({
      allowModelOverride: z.boolean().optional(),
      allowedModels: z.array(z.string()).optional(),
      allowAgentIdOverride: z.boolean().optional(),
    })
    .optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const TalkProviderEntrySchema = z
  .object({
    apiKey: SecretInputSchema.optional().register(sensitive),
  })
  .catchall(z.unknown());

const TalkRealtimeSchema = z
  .strictObject({
    provider: z.string().optional(),
    providers: z.record(z.string(), TalkProviderEntrySchema).optional(),
    model: z.string().optional(),
    speakerVoice: z.string().optional(),
    speakerVoiceId: z.string().optional(),
    instructions: z.string().optional(),
    mode: z.enum(["realtime", "stt-tts", "transcription"]).optional(),
    transport: z.enum(["webrtc", "provider-websocket", "gateway-relay", "managed-room"]).optional(),
    vadThreshold: z.number().min(0).max(1).optional(),
    silenceDurationMs: z.number().int().positive().optional(),
    prefixPaddingMs: z.number().int().nonnegative().optional(),
    reasoningEffort: z.string().min(1).optional(),
    brain: z.enum(["agent-consult", "direct-tools", "none"]).optional(),
    consultRouting: z.enum(["provider-direct", "force-agent-consult"]).optional(),
  })
  .superRefine((realtime, ctx) => {
    const provider = normalizeLowercaseStringOrEmpty(realtime.provider ?? "");
    const providers = realtime.providers ? Object.keys(realtime.providers) : [];

    if (provider && providers.length > 0 && !Object.hasOwn(realtime.providers!, provider)) {
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

export const TalkSchema = z
  .strictObject({
    provider: z.string().optional(),
    providers: z.record(z.string(), TalkProviderEntrySchema).optional(),
    realtime: TalkRealtimeSchema.optional(),
    consultThinkingLevel: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"])
      .optional(),
    consultFastMode: z.boolean().optional(),
    speechLocale: z.string().optional(),
    interruptOnSpeech: z.boolean().optional(),
    silenceTimeoutMs: z.number().int().positive().optional(),
  })
  .superRefine((talk, ctx) => {
    const provider = normalizeLowercaseStringOrEmpty(talk.provider ?? "");
    const providers = talk.providers ? Object.keys(talk.providers) : [];

    if (provider && providers.length > 0 && !Object.hasOwn(talk.providers!, provider)) {
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
    enabled: z.boolean().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z
      .record(
        z.string(),
        z.union([z.string().register(sensitive), z.number(), z.boolean()]).register(sensitive),
      )
      .optional(),
    cwd: z.string().optional(),
    url: HttpUrlSchema.optional(),
    transport: z
      .union([z.literal("stdio"), z.literal("sse"), z.literal("streamable-http")])
      .optional(),
    headers: z
      .record(
        z.string(),
        z.union([z.string().register(sensitive), z.number(), z.boolean()]).register(sensitive),
      )
      .optional(),
    connectionTimeoutMs: z.number().finite().positive().optional(),
    requestTimeoutMs: z.number().finite().positive().optional(),
    supportsParallelToolCalls: z.boolean().optional(),
    auth: z.literal("oauth").optional(),
    oauth: z
      .strictObject({
        authProfileId: z.string().trim().min(1).optional(),
        scope: z.string().trim().min(1).optional(),
        redirectUrl: HttpUrlSchema.optional(),
        clientMetadataUrl: McpOAuthClientMetadataUrlSchema.optional(),
      })
      .optional(),
    sslVerify: z.boolean().optional(),
    clientCert: z.string().optional(),
    clientKey: z.string().optional(),
    toolFilter: z
      .strictObject({
        include: z.array(z.string().trim().min(1)).min(1).optional(),
        exclude: z.array(z.string().trim().min(1)).min(1).optional(),
      })
      .optional(),
    codex: z
      .strictObject({
        agents: z
          .array(
            z
              .string()
              .trim()
              .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
          )
          .min(1)
          .optional(),
        defaultToolsApprovalMode: z.enum(["auto", "prompt", "approve"]).optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    // This schema is .catchall(z.unknown()) (open-world server options), so
    // unknown keys survive into this refine; retired aliases are rejected here.
    for (const key of [
      "connectTimeout",
      "connect_timeout",
      "timeout",
      "workingDirectory",
      "supports_parallel_tool_calls",
      "ssl_verify",
      "client_cert",
      "client_key",
    ] as const) {
      if (Object.hasOwn(data, key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unrecognized key: "${key}"`,
        });
      }
    }
    const codex = data.codex;
    if (codex && Object.hasOwn(codex, "default_tools_approval_mode")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["codex", "default_tools_approval_mode"],
        message: 'Unrecognized key: "default_tools_approval_mode"',
      });
    }
    if (Object.hasOwn(data, "disabled")) {
      const disabled = Reflect.get(data, "disabled") as unknown;
      const replacement =
        typeof disabled === "boolean"
          ? `"enabled: ${!disabled}" instead, then run "openclaw doctor --fix" to migrate existing config`
          : 'the canonical "enabled" boolean instead';
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unsupported key "disabled"; use ${replacement}`,
        path: ["disabled"],
      });
    }
    // transport "stdio" requires a non-empty command — URL-only servers must use "sse" or "streamable-http"
    if (
      data.transport === "stdio" &&
      (typeof data.command !== "string" || data.command.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '"stdio" transport requires a non-empty command',
        path: ["transport"],
      });
    }
  })
  .catchall(z.unknown());

export const McpConfigSchema = z
  .strictObject({
    servers: z.record(z.string(), McpServerSchema).optional(),
    apps: z
      .strictObject({
        enabled: z.boolean().optional(),
        sandboxOrigin: z
          .string()
          .url()
          .refine((value) => {
            try {
              const url = new URL(value);
              return (
                (url.protocol === "http:" || url.protocol === "https:") &&
                url.origin === value.replace(/\/$/u, "") &&
                !url.username &&
                !url.password
              );
            } catch {
              return false;
            }
          }, "sandboxOrigin must be an HTTP(S) origin without a path, query, or credentials")
          .optional(),
        sandboxPort: z.number().int().min(1).max(65535).optional(),
      })
      .optional(),
  })
  .optional();

const NodeHostMcpServerNameSchema = z
  .string()
  .refine(
    (value) => value.length > 0 && value === value.trim(),
    "MCP server name must be non-empty and must not have surrounding whitespace",
  );

export const NodeHostSchema = z
  .strictObject({
    agentRuns: NodeHostAgentRunsSchema,
    browserProxy: z
      .strictObject({
        enabled: z.boolean().optional(),
        allowProfiles: z.array(z.string()).optional(),
      })
      .optional(),
    mcp: z
      .strictObject({
        servers: z.record(NodeHostMcpServerNameSchema, McpServerSchema).optional(),
      })
      .optional(),
    skills: z
      .strictObject({
        enabled: z.boolean().optional(),
      })
      .optional(),
  })
  .optional();
