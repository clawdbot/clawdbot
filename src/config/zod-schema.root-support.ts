import { isHttpsUrl, isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import { findEdgeAuthIssue } from "../shared/gateway-edge-auth-headers.js";
import type { GatewayRemoteConfig } from "./types.gateway.js";
import { MemorySearchSchema } from "./zod-schema.agent-runtime.js";
import { SecretInputSchema } from "./zod-schema.core.js";
import { NodeHostAgentRunsSchema, NodeHostWorkerRunsSchema } from "./zod-schema.node-host.js";
import { sensitive } from "./zod-schema.sensitive.js";

type ConfigSchemaShape<T extends object> = {
  [Key in keyof T]-?: z.ZodType<T[Key]>;
};

const EdgeAuthHeadersSchema = z
  .record(z.string(), SecretInputSchema.register(sensitive))
  .superRefine((headers, ctx) => {
    const issue = findEdgeAuthIssue(headers);
    if (!issue) {
      return;
    }
    ctx.addIssue({
      code: "custom",
      message: issue.message,
      ...(issue.headerName ? { path: [issue.headerName] } : {}),
    });
  });

const GatewayRemoteSchemaShape = {
  url: z.string().optional(),

  transport: z.union([z.literal("ssh"), z.literal("direct")]).optional(),

  remotePort: z.number().int().min(1).max(65_535).optional(),

  token: SecretInputSchema.optional().register(sensitive),

  password: SecretInputSchema.optional().register(sensitive),
  edgeAuth: EdgeAuthHeadersSchema.optional(),
  tlsFingerprint: z.string().optional(),
  sshTarget: z.string().optional(),
  sshIdentity: z.string().optional(),
  sshHostKeyPolicy: z.union([z.literal("strict"), z.literal("openssh")]).optional(),
} satisfies ConfigSchemaShape<GatewayRemoteConfig>;

export const GatewayRemoteConfigSchema = z.strictObject(GatewayRemoteSchemaShape).optional();

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

export const LoggingLevelSchema = z.union([
  z.literal("silent"),
  z.literal("fatal"),
  z.literal("error"),
  z.literal("warn"),
  z.literal("info"),
  z.literal("debug"),
  z.literal("trace"),
]);

export const MemorySchema = z
  .strictObject({
    citations: z.union([z.literal("auto"), z.literal("on"), z.literal("off")]).optional(),
    search: MemorySearchSchema,
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
      allowedCompletionModels: z.array(z.string()).optional(),
      allowAuthProfileOverride: z.boolean().optional(),
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
    agentId: z.string().trim().min(1).optional(),
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
        z
          .union([SecretInputSchema.register(sensitive), z.number(), z.boolean()])
          .register(sensitive),
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
        z
          .union([SecretInputSchema.register(sensitive), z.number(), z.boolean()])
          .register(sensitive),
      )
      .optional(),
    connectionTimeoutMs: z.number().finite().positive().optional(),
    requestTimeoutMs: z.number().finite().positive().optional(),
    supportsParallelToolCalls: z.boolean().optional(),
    auth: z.literal("oauth").optional(),
    oauth: z
      .strictObject({
        identity: z.enum(["shared", "per-requester"]).optional(),
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
    if (data.oauth?.identity === "per-requester") {
      if (data.auth !== "oauth") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'oauth.identity "per-requester" requires auth: "oauth"',
          path: ["oauth", "identity"],
        });
      }
      if (data.oauth.authProfileId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'oauth.authProfileId cannot be used with oauth.identity "per-requester"',
          path: ["oauth", "authProfileId"],
        });
      }
      if (!data.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'oauth.identity "per-requester" requires an HTTP server URL',
          path: ["oauth", "identity"],
        });
      }
      // Command precedence would resolve stdio and strand the server: partitioned
      // out of the static runtime with no requester sign-in path.
      if (data.command !== undefined || data.transport === "stdio") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'oauth.identity "per-requester" cannot be combined with a command or "stdio" transport',
          path: ["oauth", "identity"],
        });
      }
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

const RESERVED_MCP_SERVER_NAME = "__proto__";
const RESERVED_MCP_SERVER_NAME_ERROR = 'MCP server name "__proto__" is reserved; rename the server';

export const McpServerNameSchema = z
  .string()
  .refine((value) => value !== RESERVED_MCP_SERVER_NAME, RESERVED_MCP_SERVER_NAME_ERROR);

export const NodeHostMcpServerNameSchema = McpServerNameSchema.refine(
  (value) => value.length > 0 && value === value.trim(),
  "MCP server name must be non-empty and must not have surrounding whitespace",
);

function createMcpServersSchema(serverNameSchema: z.ZodType<string>) {
  return z.preprocess(
    (value, ctx) => {
      // Plain assignment treats "__proto__" as a setter, so one unhardened map builder
      // can silently drop the server. Reject the name at the config boundary instead.
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.hasOwn(value, RESERVED_MCP_SERVER_NAME)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [RESERVED_MCP_SERVER_NAME],
          message: RESERVED_MCP_SERVER_NAME_ERROR,
        });
        return z.NEVER;
      }
      return value;
    },
    z.record(serverNameSchema, McpServerSchema),
  );
}

export function validateHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export const McpConfigSchema = z
  .strictObject({
    servers: createMcpServersSchema(McpServerNameSchema).optional(),
    apps: z
      .strictObject({
        enabled: z.boolean().optional(),
        sandboxOrigin: z
          .string()
          .url()
          .refine(
            validateHttpOrigin,
            "sandboxOrigin must be an HTTP(S) origin without a path, query, or credentials",
          )
          .optional(),
        sandboxPort: z.number().int().min(1).max(65535).optional(),
      })
      .optional(),
  })
  .optional();

export const NodeHostSchema = z
  .strictObject({
    agentRuns: NodeHostAgentRunsSchema,
    workerRuns: NodeHostWorkerRunsSchema,
    browserProxy: z
      .strictObject({
        enabled: z.boolean().optional(),
        allowProfiles: z.array(z.string()).optional(),
      })
      .optional(),
    mcp: z
      .strictObject({
        servers: createMcpServersSchema(NodeHostMcpServerNameSchema).optional(),
      })
      .optional(),
    skills: z
      .strictObject({
        enabled: z.boolean().optional(),
      })
      .optional(),
  })
  .optional();
