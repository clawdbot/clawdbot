// Strict parser for grouped Claw schema version 1 manifests.
import { z } from "zod";
import { resolveToolProfilePolicy } from "../agents/tool-policy-shared.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { computeNextRunAtMs } from "../cron/schedule.js";
import { isDangerousHostEnvVarName } from "../infra/host-env-security.js";
import { isRenderableAvatarImageDataUrl } from "../shared/avatar-limits.js";
import {
  conflictsWithClawPath,
  isCanonicalClawHubPackageName,
  isClawPackageManagerArtifactPinned,
  isExactSemVer,
  isPortableClawAvatar,
  isSafeClawRelativePath,
  isValidClawTimezone,
  portableClawPathKey,
} from "./schema-portability.js";
import {
  CLAW_BOOTSTRAP_FILE_NAMES,
  CLAW_SCHEMA_VERSION,
  type ClawDiagnostic,
  type ClawManifest,
} from "./types.js";

const nonEmptyString = z
  .string()
  .min(1)
  .refine(
    (value) => value.length === value.trim().length && value.length > 0,
    "Value must not have leading or trailing whitespace.",
  );
const optionalString = nonEmptyString.optional();
const agentId = nonEmptyString.regex(
  /^[a-z][a-z0-9_-]{0,63}$/,
  "Agent id must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens.",
);
const exactVersion = nonEmptyString.refine(
  isExactSemVer,
  "Package version must be an exact semantic version.",
);
const clawHubPackageName = nonEmptyString.refine(
  isCanonicalClawHubPackageName,
  "ClawHub package references must use their canonical lowercase name.",
);
const portableEnvKey = /^[A-Za-z_][A-Za-z0-9_]*$/;

const packageRelativePath = nonEmptyString.refine(isSafeClawRelativePath, {
  message: "Path must be package-relative and must not contain traversal segments.",
});

const identitySchema = z
  .object({
    name: optionalString,
    theme: optionalString,
    emoji: optionalString,
    avatar: nonEmptyString
      .refine(isPortableClawAvatar, {
        message:
          "Avatar must be a bounded image data URL or managed workspace-relative image path.",
      })
      .optional(),
  })
  .strict();

const agentSchema = z
  .object({
    id: agentId,
    name: optionalString,
    description: optionalString,
    identity: identitySchema.optional(),
    groupChat: z
      .object({ mentionPatterns: z.array(nonEmptyString).min(1).optional() })
      .strict()
      .optional(),
    sandbox: z
      .object({
        mode: z.enum(["off", "non-main", "all"]).optional(),
        scope: z.enum(["session", "agent", "shared"]).optional(),
        workspaceAccess: z.enum(["none", "ro", "rw"]).optional(),
      })
      .strict()
      .optional(),
    tools: z
      .object({
        profile: nonEmptyString
          .refine(
            (value) => resolveToolProfilePolicy(value) !== undefined,
            "Tool profile must name a registered OpenClaw built-in profile.",
          )
          .optional(),
        allow: z.array(nonEmptyString).min(1).optional(),
        alsoAllow: z.array(nonEmptyString).min(1).optional(),
        deny: z.array(nonEmptyString).min(1).optional(),
        fs: z
          .object({ workspaceOnly: z.literal(true).optional() })
          .strict()
          .optional(),
      })
      .strict()
      .superRefine((tools, ctx) => {
        if (tools.allow && tools.alsoAllow) {
          ctx.addIssue({
            code: "custom",
            path: ["alsoAllow"],
            message:
              "Agent tools cannot set both allow and alsoAllow; use allow alone or profile with alsoAllow.",
          });
        }
      })
      .optional(),
    memory: z
      .object({
        search: z
          .object({
            enabled: z.boolean().optional(),
            rememberAcrossConversations: z.boolean().optional(),
            sources: z
              .array(z.enum(["memory", "sessions"]))
              .min(1)
              .optional(),
          })
          .strict()
          .superRefine((search, ctx) => {
            if (
              search.sources?.includes("sessions") &&
              search.rememberAcrossConversations !== true
            ) {
              ctx.addIssue({
                code: "custom",
                path: ["rememberAcrossConversations"],
                message:
                  "The sessions source requires rememberAcrossConversations: true in a portable Claw.",
              });
            }
          })
          .optional(),
      })
      .strict()
      .optional(),
    heartbeat: z
      .object({
        every: nonEmptyString
          .refine((value) => {
            try {
              parseDurationMs(value, { defaultUnit: "m" });
              return true;
            } catch {
              return false;
            }
          }, "Invalid heartbeat duration.")
          .optional(),
        activeHours: z
          .object({
            start: nonEmptyString.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
            end: nonEmptyString.regex(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/).optional(),
            timezone: nonEmptyString
              .refine(isValidClawTimezone, "Invalid IANA timezone.")
              .optional(),
          })
          .strict()
          .optional(),
        lightContext: z.boolean().optional(),
        isolatedSession: z.boolean().optional(),
        skipWhenBusy: z.boolean().optional(),
        timeoutSeconds: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    humanDelay: z
      .object({
        mode: z.enum(["off", "natural", "custom"]).optional(),
        minMs: z.number().int().nonnegative().optional(),
        maxMs: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const workspaceSourceSchema = z.object({ source: packageRelativePath }).strict();
const bootstrapFilesSchema = z
  .object(
    Object.fromEntries(
      CLAW_BOOTSTRAP_FILE_NAMES.map((name) => [name, workspaceSourceSchema.optional()]),
    ) as Record<
      (typeof CLAW_BOOTSTRAP_FILE_NAMES)[number],
      z.ZodOptional<typeof workspaceSourceSchema>
    >,
  )
  .partial()
  .strict();

const workspaceFileSchema = z
  .object({ source: packageRelativePath, path: packageRelativePath })
  .strict();

const workspaceSchema = z
  .object({
    bootstrapFiles: bootstrapFilesSchema.optional().default({}),
    files: z.array(workspaceFileSchema).optional().default([]),
  })
  .strict()
  .default({ bootstrapFiles: {}, files: [] });

const packageSchema = z
  .object({
    kind: z.enum(["skill", "plugin"]),
    source: z.literal("clawhub"),
    ref: clawHubPackageName,
    version: exactVersion,
  })
  .strict();

const environmentReference = nonEmptyString.regex(
  /^\$\{[A-Z_][A-Z0-9_]*\}$/,
  "MCP environment values must be unresolved ${ENV_VAR} references.",
);

const mcpToolFilterSchema = z
  .object({
    include: z.array(nonEmptyString).min(1).optional(),
    exclude: z.array(nonEmptyString).min(1).optional(),
  })
  .strict()
  .superRefine((filter, ctx) => {
    for (const field of ["include", "exclude"] as const) {
      const seen = new Set<string>();
      for (const [index, value] of (filter[field] ?? []).entries()) {
        if (value.includes("?") || value.includes("[") || value.includes("]")) {
          ctx.addIssue({
            code: "custom",
            path: [field, index],
            message: "Tool filters support only exact names and * wildcards.",
          });
        }
        if (seen.has(value)) {
          ctx.addIssue({
            code: "custom",
            path: [field, index],
            message: "Tool filter entries must be unique.",
          });
        }
        seen.add(value);
      }
    }
  });

const mcpServerCommonShape = {
  toolFilter: mcpToolFilterSchema.optional(),
  timeout: z.number().finite().positive().optional(),
  connectTimeout: z.number().finite().positive().optional(),
};

const stdioMcpServerSchema = z
  .object({
    command: nonEmptyString,
    transport: z.literal("stdio").optional(),
    args: z.array(nonEmptyString).optional(),
    env: z
      .record(
        nonEmptyString.regex(portableEnvKey, "Invalid portable environment key."),
        environmentReference,
      )
      .optional(),
    ...mcpServerCommonShape,
  })
  .strict()
  .superRefine((server, ctx) => {
    if (isClawPackageManagerArtifactPinned(server.command, server.args ?? []) === false) {
      ctx.addIssue({
        code: "custom",
        path: ["args"],
        message: "Package-manager MCP commands must select one exact immutable package version.",
      });
    }
    for (const key of Object.keys(server.env ?? {})) {
      if (isDangerousHostEnvVarName(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["env", key],
          message: "Environment key is blocked by the spawned-process safety policy.",
        });
      }
    }
  });

const remoteMcpServerSchema = z
  .object({
    url: nonEmptyString.url(),
    transport: z.enum(["sse", "streamable-http"]),
    auth: z.literal("oauth").optional(),
    ...mcpServerCommonShape,
  })
  .strict()
  .superRefine((server, ctx) => {
    const url = new URL(server.url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "Remote MCP URLs must use HTTPS, except HTTP on an exact loopback host.",
      });
    }
    if (url.username || url.password || url.hash) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "Remote MCP URLs must not contain user information or fragments.",
      });
    }
  });

const mcpServerSchema = z.union([stdioMcpServerSchema, remoteMcpServerSchema]);

const cronJobSchema = z
  .object({
    id: agentId,
    name: optionalString,
    schedule: z.object({ cron: nonEmptyString, timezone: nonEmptyString }).strict(),
    session: z.enum(["main", "isolated"]),
    message: nonEmptyString,
    delivery: z
      .object({
        mode: z.enum(["none", "announce"]),
        channel: z.literal("last").optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((job, ctx) => {
    if (job.schedule.cron.trim().split(/\s+/).length !== 5) {
      ctx.addIssue({
        code: "custom",
        path: ["schedule", "cron"],
        message: "Cron schedule must use exactly five fields.",
      });
    }
    if (
      (job.delivery?.mode === "none" && job.delivery.channel !== undefined) ||
      (job.delivery?.mode === "announce" && job.delivery.channel !== "last")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["delivery"],
        message: 'Delivery must be { mode: "none" } or { mode: "announce", channel: "last" }.',
      });
    }
    try {
      computeNextRunAtMs(
        { kind: "cron", expr: job.schedule.cron, tz: job.schedule.timezone },
        Date.now(),
      );
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["schedule", "cron"],
        message: "Invalid cron expression or timezone.",
      });
    }
  });

const manifestSchema = z
  .object({
    schemaVersion: z.literal(CLAW_SCHEMA_VERSION),
    agent: agentSchema,
    workspace: workspaceSchema.optional().default({ bootstrapFiles: {}, files: [] }),
    packages: z.array(packageSchema).optional().default([]),
    mcpServers: z
      .record(
        nonEmptyString.regex(/^[a-z][a-z0-9_-]{0,63}$/, "Invalid MCP server name."),
        mcpServerSchema,
      )
      .optional()
      .default({}),
    cronJobs: z.array(cronJobSchema).optional().default([]),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const workspaceTargets = new Set<string>();
    for (const name of CLAW_BOOTSTRAP_FILE_NAMES) {
      if (manifest.workspace.bootstrapFiles[name]) {
        workspaceTargets.add(portableClawPathKey(name));
      }
    }
    manifest.workspace.files.forEach((file, index) => {
      const destinationKey = portableClawPathKey(file.path);
      if (conflictsWithClawPath(workspaceTargets, destinationKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["workspace", "files", index, "path"],
          message: `Workspace destination ${JSON.stringify(file.path)} is declared more than once.`,
        });
      }
      workspaceTargets.add(destinationKey);
    });

    const packageKeys = new Set<string>();
    manifest.packages.forEach((pkg, index) => {
      const key = `${pkg.kind}:${pkg.source}:${pkg.ref.toLowerCase()}`;
      if (packageKeys.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["packages", index],
          message: `Package ${JSON.stringify(pkg.ref)} is declared more than once for ${pkg.kind}.`,
        });
      }
      packageKeys.add(key);
    });

    const managedPaths = new Set(
      manifest.workspace.files.map((file) => portableClawPathKey(file.path)),
    );
    const avatar = manifest.agent.identity?.avatar;
    if (
      avatar &&
      !isRenderableAvatarImageDataUrl(avatar) &&
      !managedPaths.has(portableClawPathKey(avatar))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["agent", "identity", "avatar"],
        message: "Workspace-relative avatar must match a workspace.files destination.",
      });
    }

    const cronIds = new Set<string>();
    manifest.cronJobs.forEach((job, index) => {
      if (cronIds.has(job.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["cronJobs", index, "id"],
          message: `Cron job id ${JSON.stringify(job.id)} is declared more than once.`,
        });
      }
      cronIds.add(job.id);
    });
  });

function formatIssuePath(path: PropertyKey[]): string {
  if (path.length === 0) {
    return "$";
  }
  return `$${path
    .map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`))
    .join("")}`;
}

function diagnosticsFromZodError(error: z.ZodError): ClawDiagnostic[] {
  return error.issues.map((issue) => ({
    level: "error",
    code: "invalid_manifest",
    phase: "schema",
    path: formatIssuePath(issue.path),
    message: issue.message,
  }));
}

export function parseClawManifest(
  value: unknown,
):
  | { ok: true; manifest: ClawManifest; diagnostics: ClawDiagnostic[] }
  | { ok: false; diagnostics: ClawDiagnostic[] } {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, diagnostics: diagnosticsFromZodError(parsed.error) };
  }
  return { ok: true, manifest: parsed.data as ClawManifest, diagnostics: [] };
}
