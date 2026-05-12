import { z } from "zod";
import { splitSandboxBindSpec } from "../agents/sandbox/bind-spec.js";
import { isSandboxHostPathAbsolute } from "../agents/sandbox/host-paths.js";
import { getBlockedNetworkModeReason } from "../agents/sandbox/network-mode.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { AgentModelSchema } from "./zod-schema.agent-model.js";
import {
  GroupChatSchema,
  HumanDelaySchema,
  IdentitySchema,
  SecretInputSchema,
  ToolsLinksSchema,
  ToolsMediaSchema,
  TtsConfigSchema,
} from "./zod-schema.core.js";
import { sensitive } from "./zod-schema.sensitive.js";

export const AgentRunRetriesConfigSchema = z
  .object({
    base: z.number().int().positive().optional(),
    perProfile: z.number().int().nonnegative().optional(),
    min: z.number().int().positive().optional(),
    max: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.min !== undefined && data.max !== undefined) {
        return data.max >= data.min;
      }
      return true;
    },
    { message: "max must be greater than or equal to min", path: ["max"] },
  );

export const HeartbeatSchema = z
  .object({
    every: z.string().optional(),
    activeHours: z
      .object({
        start: z.string().optional(),
        end: z.string().optional(),
        timezone: z.string().optional(),
      })
      .strict()
      .optional(),
    model: z.string().optional(),
    session: z.string().optional(),
    includeReasoning: z.boolean().optional(),
    target: z.string().optional(),
    directPolicy: z.union([z.literal("allow"), z.literal("block")]).optional(),
    to: z.string().optional(),
    accountId: z.string().optional(),
    prompt: z.string().optional(),
    includeSystemPromptSection: z.boolean().optional(),
    ackMaxChars: z.number().int().nonnegative().optional(),
    suppressToolErrorWarnings: z.boolean().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    lightContext: z.boolean().optional(),
    isolatedSession: z.boolean().optional(),
    skipWhenBusy: z.boolean().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (!val.every) {
      return;
    }
    try {
      parseDurationMs(val.every, { defaultUnit: "m" });
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["every"],
        message: "invalid duration (use ms, s, m, h)",
      });
    }

    const active = val.activeHours;
    if (!active) {
      return;
    }
    const timePattern = /^([01]\d|2[0-3]|24):([0-5]\d)$/;
    const validateTime = (raw: string | undefined, opts: { allow24: boolean }, path: string) => {
      if (!raw) {
        return;
      }
      if (!timePattern.test(raw)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeHours", path],
          message: 'invalid time (use "HH:MM" 24h format)',
        });
        return;
      }
      const [hourStr, minuteStr] = raw.split(":");
      const hour = Number(hourStr);
      const minute = Number(minuteStr);
      if (hour === 24 && minute !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeHours", path],
          message: "invalid time (24:00 is the only allowed 24:xx value)",
        });
        return;
      }
      if (hour === 24 && !opts.allow24) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeHours", path],
          message: "invalid time (start cannot be 24:00)",
        });
      }
    };

    validateTime(active.start, { allow24: false }, "start");
    validateTime(active.end, { allow24: true }, "end");
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
    setupCommand: z
      .union([z.string(), z.array(z.string())])
      .transform((value) => (Array.isArray(value) ? value.join("\n") : value))
      .optional(),
    pidsLimit: z.number().int().positive().optional(),
    memory: z.union([z.string(), z.number()]).optional(),
    memorySwap: z.union([z.string(), z.number()]).optional(),
    cpus: z.number().positive().optional(),
    gpus: z.string().min(1).optional(),
    ulimits: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.number(),
          z
            .object({
              soft: z.number().int().nonnegative().optional(),
              hard: z.number().int().nonnegative().optional(),
            })
            .strict(),
        ]),
      )
      .optional(),
    seccompProfile: z.string().optional(),
    apparmorProfile: z.string().optional(),
    dns: z.array(z.string()).optional(),
    extraHosts: z.array(z.string()).optional(),
    binds: z.array(z.string()).optional(),
    dangerouslyAllowReservedContainerTargets: z.boolean().optional(),
    dangerouslyAllowExternalBindSources: z.boolean().optional(),
    dangerouslyAllowContainerNamespaceJoin: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.binds) {
      for (let i = 0; i < data.binds.length; i += 1) {
        const bind = normalizeOptionalString(data.binds[i]) ?? "";
        if (!bind) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["binds", i],
            message: "Sandbox security: bind mount entry must be a non-empty string.",
          });
          continue;
        }

        const parsed = splitSandboxBindSpec(bind);
        const source = (parsed ? parsed.host : bind).trim();
        if (!isSandboxHostPathAbsolute(source)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["binds", i],
            message:
              `Sandbox security: bind mount "${bind}" uses a non-absolute source path "${source}". ` +
              "Only absolute POSIX or Windows drive-letter paths are supported for sandbox binds.",
          });
        }
      }
    }
    const blockedNetworkReason = getBlockedNetworkModeReason({
      network: data.network,
      allowContainerNamespaceJoin: data.dangerouslyAllowContainerNamespaceJoin === true,
    });
    if (blockedNetworkReason === "host") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["network"],
        message:
          'Sandbox security: network mode "host" is blocked. Use "bridge" or "none" instead.',
      });
    }
    if (blockedNetworkReason === "container_namespace_join") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["network"],
        message:
          'Sandbox security: network mode "container:*" is blocked by default. ' +
          "Use a custom bridge network, or set dangerouslyAllowContainerNamespaceJoin=true only when you fully trust this runtime.",
      });
    }
    if (normalizeLowercaseStringOrEmpty(data.seccompProfile ?? "") === "unconfined") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["seccompProfile"],
        message:
          'Sandbox security: seccomp profile "unconfined" is blocked. ' +
          "Use a custom seccomp profile file or omit this setting.",
      });
    }
    if (normalizeLowercaseStringOrEmpty(data.apparmorProfile ?? "") === "unconfined") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apparmorProfile"],
        message:
          'Sandbox security: apparmor profile "unconfined" is blocked. ' +
          "Use a named AppArmor profile or omit this setting.",
      });
    }
  })
  .optional();

const SandboxBrowserSchema = z
  .object({
    enabled: z.boolean().optional(),
    image: z.string().optional(),
    containerPrefix: z.string().optional(),
    network: z.string().optional(),
    cdpPort: z.number().int().positive().optional(),
    cdpSourceRange: z.string().optional(),
    vncPort: z.number().int().positive().optional(),
    noVncPort: z.number().int().positive().optional(),
    headless: z.boolean().optional(),
    enableNoVnc: z.boolean().optional(),
    allowHostControl: z.boolean().optional(),
    autoStart: z.boolean().optional(),
    autoStartTimeoutMs: z.number().int().positive().optional(),
    binds: z.array(z.string()).optional(),
  })
  .superRefine((data, ctx) => {
    if (normalizeLowercaseStringOrEmpty(data.network ?? "") === "host") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["network"],
        message:
          'Sandbox security: browser network mode "host" is blocked. Use "bridge" or a custom bridge network instead.',
      });
    }
  })
  .strict()
  .optional();

const SandboxPruneSchema = z
  .object({
    idleHours: z.number().int().nonnegative().optional(),
    maxAgeDays: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional();

export const AgentContextLimitsSchema = z
  .object({
    memoryGetMaxChars: z.number().int().min(1).max(250_000).optional(),
    memoryGetDefaultLines: z.number().int().min(1).max(5_000).optional(),
    toolResultMaxChars: z.number().int().min(1).max(250_000).optional(),
    postCompactionMaxChars: z.number().int().min(1).max(50_000).optional(),
  })
  .strict()
  .optional();

const AgentSkillsLimitsSchema = z
  .object({
    maxSkillsPromptChars: z.number().int().min(0).optional(),
  })
  .strict()
  .optional();

const ToolPolicyBaseSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    alsoAllow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict();

export const ToolPolicySchema = ToolPolicyBaseSchema.superRefine((value, ctx) => {
  if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "tools policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
    });
  }
}).optional();

const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const TrimmedOptionalConfigStringSchema = z
  .string()
  .transform((value) => {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  })
  .optional();

const CodexAllowedDomainsSchema = z
  .array(z.string())
  .transform((values) => {
    const deduped = [
      ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
    ];
    return deduped.length > 0 ? deduped : undefined;
  })
  .optional();

const CodexUserLocationSchema = z
  .object({
    country: TrimmedOptionalConfigStringSchema,
    region: TrimmedOptionalConfigStringSchema,
    city: TrimmedOptionalConfigStringSchema,
    timezone: TrimmedOptionalConfigStringSchema,
  })
  .strict()
  .transform((value) => {
    return value.country || value.region || value.city || value.timezone ? value : undefined;
  })
  .optional();

const ToolsWebSearchSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: z.string().optional(),
    maxResults: z.number().int().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    cacheTtlMinutes: z.number().nonnegative().optional(),
    apiKey: SecretInputSchema.optional().register(sensitive),
    openaiCodex: z
      .object({
        enabled: z.boolean().optional(),
        mode: z.union([z.literal("cached"), z.literal("live")]).optional(),
        allowedDomains: CodexAllowedDomainsSchema,
        contextSize: z.union([z.literal("low"), z.literal("medium"), z.literal("high")]).optional(),
        userLocation: CodexUserLocationSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const ToolsWebFetchSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: z.string().optional(),
    maxChars: z.number().int().positive().optional(),
    maxCharsCap: z.number().int().positive().optional(),
    maxResponseBytes: z.number().int().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    cacheTtlMinutes: z.number().nonnegative().optional(),
    maxRedirects: z.number().int().nonnegative().optional(),
    userAgent: z.string().optional(),
    readability: z.boolean().optional(),
    useTrustedEnvProxy: z.boolean().optional(),
    ssrfPolicy: z
      .object({
        allowRfc2544BenchmarkRange: z.boolean().optional(),
        allowIpv6UniqueLocalRange: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // Keep the legacy Firecrawl fetch shape loadable so existing installs can
    // start and then migrate cleanly through doctor.
    firecrawl: z
      .object({
        enabled: z.boolean().optional(),
        apiKey: SecretInputSchema.optional().register(sensitive),
        baseUrl: z.string().optional(),
        onlyMainContent: z.boolean().optional(),
        maxAgeMs: z.number().int().nonnegative().optional(),
        timeoutSeconds: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const ToolsWebXSearchSchema = z
  .object({
    enabled: z.boolean().optional(),
    model: z.string().optional(),
    inlineCitations: z.boolean().optional(),
    maxTurns: z.number().int().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    cacheTtlMinutes: z.number().nonnegative().optional(),
  })
  .strict()
  .optional();

const ToolsWebSchema = z
  .object({
    search: ToolsWebSearchSchema,
    fetch: ToolsWebFetchSchema,
    x_search: ToolsWebXSearchSchema,
  })
  .strict()
  .optional();

const ToolProfileSchema = z
  .union([z.literal("minimal"), z.literal("coding"), z.literal("messaging"), z.literal("full")])
  .optional();

type AllowlistPolicy = {
  allow?: string[];
  alsoAllow?: string[];
};

function addAllowAlsoAllowConflictIssue(
  value: AllowlistPolicy,
  ctx: z.RefinementCtx,
  message: string,
): void {
  if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message,
    });
  }
}

const ToolPolicyWithProfileSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    alsoAllow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    profile: ToolProfileSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addAllowAlsoAllowConflictIssue(
      value,
      ctx,
      "tools.byProvider policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
    );
  });

// Provider docking: allowlists keyed by provider id (no schema updates when adding providers).
export const ElevatedAllowFromSchema = z
  .record(z.string(), z.array(z.union([z.string(), z.number()])))
  .optional();

const ToolExecApplyPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    workspaceOnly: z.boolean().optional(),
    allowModels: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

const ToolExecSafeBinProfileSchema = z
  .object({
    minPositional: z.number().int().nonnegative().optional(),
    maxPositional: z.number().int().nonnegative().optional(),
    allowedValueFlags: z.array(z.string()).optional(),
    deniedFlags: z.array(z.string()).optional(),
  })
  .strict();

const ToolExecBaseShape = {
  host: z.enum(["auto", "sandbox", "gateway", "node"]).optional(),
  security: z.enum(["deny", "allowlist", "full"]).optional(),
  ask: z.enum(["off", "on-miss", "always"]).optional(),
  node: z.string().optional(),
  pathPrepend: z.array(z.string()).optional(),
  safeBins: z.array(z.string()).optional(),
  strictInlineEval: z.boolean().optional(),
  commandHighlighting: z.boolean().optional(),
  safeBinTrustedDirs: z.array(z.string()).optional(),
  safeBinProfiles: z.record(z.string(), ToolExecSafeBinProfileSchema).optional(),
  backgroundMs: z.number().int().positive().optional(),
  timeoutSec: z.number().int().positive().optional(),
  cleanupMs: z.number().int().positive().optional(),
  notifyOnExit: z.boolean().optional(),
  notifyOnExitEmptySuccess: z.boolean().optional(),
  applyPatch: ToolExecApplyPatchSchema,
} as const;

const AgentToolExecSchema = z
  .object({
    ...ToolExecBaseShape,
    approvalRunningNoticeMs: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional();

const ToolExecSchema = z.object(ToolExecBaseShape).strict().optional();

const ToolFsSchema = z
  .object({
    workspaceOnly: z.boolean().optional(),
  })
  .strict()
  .optional();

const ToolLoopDetectionDetectorSchema = z
  .object({
    genericRepeat: z.boolean().optional(),
    knownPollNoProgress: z.boolean().optional(),
    pingPong: z.boolean().optional(),
  })
  .strict()
  .optional();

const ToolLoopPostCompactionGuardSchema = z
  .object({
    windowSize: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

const ToolLoopDetectionSchema = z
  .object({
    enabled: z.boolean().optional(),
    historySize: z.number().int().positive().optional(),
    warningThreshold: z.number().int().positive().optional(),
    unknownToolThreshold: z.number().int().positive().optional(),
    criticalThreshold: z.number().int().positive().optional(),
    globalCircuitBreakerThreshold: z.number().int().positive().optional(),
    detectors: ToolLoopDetectionDetectorSchema,
    postCompactionGuard: ToolLoopPostCompactionGuardSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.warningThreshold !== undefined &&
      value.criticalThreshold !== undefined &&
      value.warningThreshold >= value.criticalThreshold
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["criticalThreshold"],
        message: "tools.loopDetection.warningThreshold must be lower than criticalThreshold.",
      });
    }
    if (
      value.criticalThreshold !== undefined &&
      value.globalCircuitBreakerThreshold !== undefined &&
      value.criticalThreshold >= value.globalCircuitBreakerThreshold
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["globalCircuitBreakerThreshold"],
        message:
          "tools.loopDetection.criticalThreshold must be lower than globalCircuitBreakerThreshold.",
      });
    }
  })
  .optional();

const ToolSearchSchema = z
  .union([
    z.boolean(),
    z
      .object({
        enabled: z.boolean().optional(),
        mode: z.enum(["code", "tools"]).optional(),
        codeTimeoutMs: z.number().int().positive().optional(),
        searchDefaultLimit: z.number().int().positive().optional(),
        maxSearchLimit: z.number().int().positive().optional(),
      })
      .strict(),
  ])
  .optional();

const SandboxSshSchema = z
  .object({
    target: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    workspaceRoot: z.string().min(1).optional(),
    strictHostKeyChecking: z.boolean().optional(),
    updateHostKeys: z.boolean().optional(),
    identityFile: z.string().min(1).optional(),
    certificateFile: z.string().min(1).optional(),
    knownHostsFile: z.string().min(1).optional(),
    identityData: SecretInputSchema.optional().register(sensitive),
    certificateData: SecretInputSchema.optional().register(sensitive),
    knownHostsData: SecretInputSchema.optional().register(sensitive),
  })
  .strict()
  .optional();

export const AgentSandboxSchema = z
  .object({
    mode: z.union([z.literal("off"), z.literal("non-main"), z.literal("all")]).optional(),
    backend: z.string().min(1).optional(),
    workspaceAccess: z.union([z.literal("none"), z.literal("ro"), z.literal("rw")]).optional(),
    sessionToolsVisibility: z.union([z.literal("spawned"), z.literal("all")]).optional(),
    scope: z.union([z.literal("session"), z.literal("agent"), z.literal("shared")]).optional(),
    workspaceRoot: z.string().optional(),
    docker: SandboxDockerSchema,
    ssh: SandboxSshSchema,
    browser: SandboxBrowserSchema,
    prune: SandboxPruneSchema,
  })
  .strict()
  .superRefine((data, ctx) => {
    const blockedBrowserNetworkReason = getBlockedNetworkModeReason({
      network: data.browser?.network,
      allowContainerNamespaceJoin: data.docker?.dangerouslyAllowContainerNamespaceJoin === true,
    });
    if (blockedBrowserNetworkReason === "container_namespace_join") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["browser", "network"],
        message:
          'Sandbox security: browser network mode "container:*" is blocked by default. ' +
          "Set sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true only when you fully trust this runtime.",
      });
    }
  })
  .optional();

const CommonToolPolicyFields = {
  profile: ToolProfileSchema,
  allow: z.array(z.string()).optional(),
  alsoAllow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  byProvider: z.record(z.string(), ToolPolicyWithProfileSchema).optional(),
  toolsBySender: ToolPolicyBySenderSchema,
};

const MessageToolConfigSchema = z
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
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    actions: z
      .object({
        allow: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    broadcast: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const AgentToolsSchema = z
  .object({
    ...CommonToolPolicyFields,
    elevated: z
      .object({
        enabled: z.boolean().optional(),
        allowFrom: ElevatedAllowFromSchema,
      })
      .strict()
      .optional(),
    exec: AgentToolExecSchema,
    fs: ToolFsSchema,
    loopDetection: ToolLoopDetectionSchema,
    message: MessageToolConfigSchema,
    sandbox: z
      .object({
        tools: ToolPolicySchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addAllowAlsoAllowConflictIssue(
      value,
      ctx,
      "agent tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
    );
  })
  .optional();

export const MemorySearchSchema = z
  .object({
    enabled: z.boolean().optional(),
    sources: z.array(z.union([z.literal("memory"), z.literal("sessions")])).optional(),
    extraPaths: z.array(z.string()).optional(),
    qmd: z
      .object({
        extraCollections: z
          .array(
            z
              .object({
                path: z.string(),
                name: z.string().optional(),
                pattern: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    multimodal: z
      .object({
        enabled: z.boolean().optional(),
        modalities: z
          .array(z.union([z.literal("image"), z.literal("audio"), z.literal("all")]))
          .optional(),
        maxFileBytes: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    experimental: z
      .object({
        sessionMemory: z.boolean().optional(),
      })
      .strict()
      .optional(),
    provider: z.string().optional(),
    remote: z
      .object({
        baseUrl: z.string().optional(),
        apiKey: SecretInputSchema.optional().register(sensitive),
        headers: z.record(z.string(), z.string()).optional(),
        nonBatchConcurrency: z.number().int().positive().optional(),
        batch: z
          .object({
            enabled: z.boolean().optional(),
            wait: z.boolean().optional(),
            concurrency: z.number().int().positive().optional(),
            pollIntervalMs: z.number().int().nonnegative().optional(),
            timeoutMinutes: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    fallback: z.string().optional(),
    model: z.string().optional(),
    inputType: z.string().min(1).optional(),
    queryInputType: z.string().min(1).optional(),
    documentInputType: z.string().min(1).optional(),
    outputDimensionality: z.number().int().positive().optional(),
    local: z
      .object({
        modelPath: z.string().optional(),
        modelCacheDir: z.string().optional(),
        contextSize: z.union([z.number().int().positive(), z.literal("auto")]).optional(),
      })
      .strict()
      .optional(),
    store: z
      .object({
        driver: z.literal("sqlite").optional(),
        path: z.string().optional(),
        fts: z
          .object({
            tokenizer: z.union([z.literal("unicode61"), z.literal("trigram")]).optional(),
          })
          .strict()
          .optional(),
        vector: z
          .object({
            enabled: z.boolean().optional(),
            extensionPath: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    chunking: z
      .object({
        tokens: z.number().int().positive().optional(),
        overlap: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    sync: z
      .object({
        onSessionStart: z.boolean().optional(),
        onSearch: z.boolean().optional(),
        watch: z.boolean().optional(),
        watchDebounceMs: z.number().int().nonnegative().optional(),
        intervalMinutes: z.number().int().nonnegative().optional(),
        embeddingBatchTimeoutSeconds: z.number().int().positive().optional(),
        sessions: z
          .object({
            deltaBytes: z.number().int().nonnegative().optional(),
            deltaMessages: z.number().int().nonnegative().optional(),
            postCompactionForce: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
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
            mmr: z
              .object({
                enabled: z.boolean().optional(),
                lambda: z.number().min(0).max(1).optional(),
              })
              .strict()
              .optional(),
            temporalDecay: z
              .object({
                enabled: z.boolean().optional(),
                halfLifeDays: z.number().int().positive().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    cache: z
      .object({
        enabled: z.boolean().optional(),
        maxEntries: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
export { AgentModelSchema };

const AgentRuntimeAcpSchema = z
  .object({
    agent: z.string().optional(),
    backend: z.string().optional(),
    mode: z.enum(["persistent", "oneshot"]).optional(),
    cwd: z.string().optional(),
  })
  .strict()
  .optional();

const AgentRuntimeSchema = z
  .union([
    z
      .object({
        type: z.literal("embedded"),
      })
      .strict(),
    z
      .object({
        type: z.literal("acp"),
        acp: AgentRuntimeAcpSchema,
      })
      .strict(),
  ])
  .optional();

export const AgentEmbeddedHarnessSchema = z
  .object({
    runtime: z.string().optional(),
  })
  .strict()
  .optional();

export const AgentRuntimePolicySchema = z
  .object({
    id: z.string().optional(),
  })
  .strict()
  .optional();

export const AgentEntrySchema = z
  .object({
    id: z.string(),
    default: z.boolean().optional(),
    name: z.string().optional(),
    workspace: z.string().optional(),
    agentDir: z.string().optional(),
    systemPromptOverride: z.string().optional(),
    agentRuntime: AgentRuntimePolicySchema,
    embeddedHarness: AgentEmbeddedHarnessSchema,
    model: AgentModelSchema.optional(),
    models: z
      .record(
        z.string(),
        z
          .object({
            alias: z.string().optional(),
            params: z.record(z.string(), z.unknown()).optional(),
            agentRuntime: AgentRuntimePolicySchema,
            streaming: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    thinkingDefault: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"])
      .optional(),
    verboseDefault: z.enum(["off", "on", "full"]).optional(),
    toolProgressDetail: z.enum(["explain", "raw"]).optional(),
    reasoningDefault: z.enum(["on", "off", "stream"]).optional(),
    fastModeDefault: z.boolean().optional(),
    skills: z.array(z.string()).optional(),
    memorySearch: MemorySearchSchema,
    humanDelay: HumanDelaySchema.optional(),
    tts: TtsConfigSchema,
    skillsLimits: AgentSkillsLimitsSchema,
    contextLimits: AgentContextLimitsSchema,
    contextTokens: z.number().int().positive().optional(),
    heartbeat: HeartbeatSchema,
    identity: IdentitySchema,
    groupChat: GroupChatSchema,
    subagents: z
      .object({
        delegationMode: z.enum(["suggest", "prefer"]).optional(),
        allowAgents: z.array(z.string()).optional(),
        model: z
          .union([
            z.string(),
            z
              .object({
                primary: z.string().optional(),
                fallbacks: z.array(z.string()).optional(),
              })
              .strict(),
          ])
          .optional(),
        thinking: z.string().optional(),
        requireAgentId: z.boolean().optional(),
      })
      .strict()
      .optional(),
    runRetries: AgentRunRetriesConfigSchema.optional(),
    embeddedPi: z
      .object({
        executionContract: z.union([z.literal("default"), z.literal("strict-agentic")]).optional(),
      })
      .strict()
      .optional(),
    sandbox: AgentSandboxSchema,
    params: z.record(z.string(), z.unknown()).optional(),
    tools: AgentToolsSchema,
    runtime: AgentRuntimeSchema,
  })
  .strict();

export const ToolsSchema = z
  .object({
    ...CommonToolPolicyFields,
    web: ToolsWebSchema,
    media: ToolsMediaSchema,
    links: ToolsLinksSchema,
    sessions: z
      .object({
        visibility: z.enum(["self", "tree", "agent", "all"]).optional(),
      })
      .strict()
      .optional(),
    loopDetection: ToolLoopDetectionSchema,
    toolSearch: ToolSearchSchema,
    message: MessageToolConfigSchema,
    agentToAgent: z
      .object({
        enabled: z.boolean().optional(),
        allow: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    elevated: z
      .object({
        enabled: z.boolean().optional(),
        allowFrom: ElevatedAllowFromSchema,
      })
      .strict()
      .optional(),
    exec: ToolExecSchema,
    fs: ToolFsSchema,
    subagents: z
      .object({
        tools: ToolPolicySchema,
      })
      .strict()
      .optional(),
    sandbox: z
      .object({
        tools: ToolPolicySchema,
      })
      .strict()
      .optional(),
    sessions_spawn: z
      .object({
        attachments: z
          .object({
            enabled: z.boolean().optional(),
            maxTotalBytes: z.number().optional(),
            maxFiles: z.number().optional(),
            maxFileBytes: z.number().optional(),
            retainOnSessionKeep: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    experimental: z
      .object({
        planTool: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addAllowAlsoAllowConflictIssue(
      value,
      ctx,
      "tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
    );
  })
  .optional();
