import { z } from "zod";

import { parseDurationMs } from "../cli/parse-duration.js";
import {
  GroupChatSchema,
  HumanDelaySchema,
  IdentitySchema,
  ToolsMediaSchema,
} from "./zod-schema.core.js";

export const HeartbeatSchema = z
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

export const SandboxDockerSchema = z
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
    binds: z.array(z.string()).optional(),
  })
  .optional();

export const SandboxBrowserSchema = z
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

export const SandboxPruneSchema = z
  .object({
    idleHours: z.number().int().nonnegative().optional(),
    maxAgeDays: z.number().int().nonnegative().optional(),
  })
  .optional();

export const ToolPolicySchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .optional();

export const ToolsWebSearchSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: z.union([z.literal("brave")]).optional(),
    apiKey: z.string().optional(),
    maxResults: z.number().int().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    cacheTtlMinutes: z.number().nonnegative().optional(),
  })
  .optional();

export const ToolsWebFetchSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxChars: z.number().int().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    cacheTtlMinutes: z.number().nonnegative().optional(),
    userAgent: z.string().optional(),
  })
  .optional();

export const ToolsWebSchema = z
  .object({
    search: ToolsWebSearchSchema,
    fetch: ToolsWebFetchSchema,
  })
  .optional();

export const ToolProfileSchema = z
  .union([z.literal("minimal"), z.literal("coding"), z.literal("messaging"), z.literal("full")])
  .optional();

export const ToolPolicyWithProfileSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  profile: ToolProfileSchema,
});

// Provider docking: allowlists keyed by provider id (no schema updates when adding providers).
export const ElevatedAllowFromSchema = z
  .record(z.string(), z.array(z.union([z.string(), z.number()])))
  .optional();

export const AgentSandboxSchema = z
  .object({
    mode: z.union([z.literal("off"), z.literal("non-main"), z.literal("all")]).optional(),
    workspaceAccess: z.union([z.literal("none"), z.literal("ro"), z.literal("rw")]).optional(),
    sessionToolsVisibility: z.union([z.literal("spawned"), z.literal("all")]).optional(),
    scope: z.union([z.literal("session"), z.literal("agent"), z.literal("shared")]).optional(),
    perSession: z.boolean().optional(),
    workspaceRoot: z.string().optional(),
    docker: SandboxDockerSchema,
    browser: SandboxBrowserSchema,
    prune: SandboxPruneSchema,
  })
  .optional();

export const AgentToolsSchema = z
  .object({
    profile: ToolProfileSchema,
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    byProvider: z.record(z.string(), ToolPolicyWithProfileSchema).optional(),
    elevated: z
      .object({
        enabled: z.boolean().optional(),
        allowFrom: ElevatedAllowFromSchema,
      })
      .optional(),
    exec: z
      .object({
        host: z.enum(["sandbox", "gateway", "node"]).optional(),
        security: z.enum(["deny", "allowlist", "full"]).optional(),
        ask: z.enum(["off", "on-miss", "always"]).optional(),
        node: z.string().optional(),
        backgroundMs: z.number().int().positive().optional(),
        timeoutSec: z.number().int().positive().optional(),
        cleanupMs: z.number().int().positive().optional(),
        notifyOnExit: z.boolean().optional(),
        applyPatch: z
          .object({
            enabled: z.boolean().optional(),
            allowModels: z.array(z.string()).optional(),
          })
          .optional(),
      })
      .optional(),
    sandbox: z
      .object({
        tools: ToolPolicySchema,
      })
      .optional(),
  })
  .optional();

export const MemorySearchSchema = z
  .object({
    enabled: z.boolean().optional(),
    sources: z.array(z.union([z.literal("memory"), z.literal("sessions")])).optional(),
    experimental: z
      .object({
        sessionMemory: z.boolean().optional(),
      })
      .optional(),
    provider: z.union([z.literal("openai"), z.literal("local")]).optional(),
    remote: z
      .object({
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        batch: z
          .object({
            enabled: z.boolean().optional(),
            wait: z.boolean().optional(),
            concurrency: z.number().int().positive().optional(),
            pollIntervalMs: z.number().int().nonnegative().optional(),
            timeoutMinutes: z.number().int().positive().optional(),
          })
          .optional(),
      })
      .optional(),
    fallback: z.union([z.literal("openai"), z.literal("none")]).optional(),
    model: z.string().optional(),
    local: z
      .object({
        modelPath: z.string().optional(),
        modelCacheDir: z.string().optional(),
      })
      .optional(),
    store: z
      .object({
        driver: z.literal("sqlite").optional(),
        path: z.string().optional(),
        vector: z
          .object({
            enabled: z.boolean().optional(),
            extensionPath: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    chunking: z
      .object({
        tokens: z.number().int().positive().optional(),
        overlap: z.number().int().nonnegative().optional(),
      })
      .optional(),
    sync: z
      .object({
        onSessionStart: z.boolean().optional(),
        onSearch: z.boolean().optional(),
        watch: z.boolean().optional(),
        watchDebounceMs: z.number().int().nonnegative().optional(),
        intervalMinutes: z.number().int().nonnegative().optional(),
      })
      .optional(),
    query: z
      .object({
        maxResults: z.number().int().positive().optional(),
        minScore: z.number().min(0).max(1).optional(),
        hybrid: z
          .object({
            enabled: z.boolean().optional(),
            vectorWeight: z.number().min(0).max(1).optional(),
            textWeight: z.number().min(0).max(1).optional(),
            candidateMultiplier: z.number().int().positive().optional(),
          })
          .optional(),
      })
      .optional(),
    cache: z
      .object({
        enabled: z.boolean().optional(),
        maxEntries: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .optional();
export const AgentModelSchema = z.union([
  z.string(),
  z.object({
    primary: z.string().optional(),
    fallbacks: z.array(z.string()).optional(),
  }),
]);
export const AgentEntrySchema = z.object({
  id: z.string(),
  default: z.boolean().optional(),
  name: z.string().optional(),
  workspace: z.string().optional(),
  agentDir: z.string().optional(),
  model: AgentModelSchema.optional(),
  memorySearch: MemorySearchSchema,
  humanDelay: HumanDelaySchema.optional(),
  heartbeat: HeartbeatSchema,
  identity: IdentitySchema,
  groupChat: GroupChatSchema,
  subagents: z
    .object({
      allowAgents: z.array(z.string()).optional(),
      model: z
        .union([
          z.string(),
          z.object({
            primary: z.string().optional(),
            fallbacks: z.array(z.string()).optional(),
          }),
        ])
        .optional(),
    })
    .optional(),
  sandbox: AgentSandboxSchema,
  tools: AgentToolsSchema,
});

export const ToolsSchema = z
  .object({
    profile: ToolProfileSchema,
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    byProvider: z.record(z.string(), ToolPolicyWithProfileSchema).optional(),
    web: ToolsWebSchema,
    media: ToolsMediaSchema,
    message: z
      .object({
        allowCrossContextSend: z.boolean().optional(),
        crossContext: z
          .object({
            allowWithinProvider: z.boolean().optional(),
            allowAcrossProviders: z.boolean().optional(),
            marker: z
              .object({
                enabled: z.boolean().optional(),
                prefix: z.string().optional(),
                suffix: z.string().optional(),
              })
              .optional(),
          })
          .optional(),
        broadcast: z
          .object({
            enabled: z.boolean().optional(),
          })
          .optional(),
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
    exec: z
      .object({
        host: z.enum(["sandbox", "gateway", "node"]).optional(),
        security: z.enum(["deny", "allowlist", "full"]).optional(),
        ask: z.enum(["off", "on-miss", "always"]).optional(),
        node: z.string().optional(),
        backgroundMs: z.number().int().positive().optional(),
        timeoutSec: z.number().int().positive().optional(),
        cleanupMs: z.number().int().positive().optional(),
        notifyOnExit: z.boolean().optional(),
        applyPatch: z
          .object({
            enabled: z.boolean().optional(),
            allowModels: z.array(z.string()).optional(),
          })
          .optional(),
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
