import { Cron } from "croner";
import { z } from "zod";
import {
  conflictsWithClawPath,
  isCanonicalClawHubPackageName,
  isClawPackageManagerArtifactPinned,
  isExactSemVer,
  isPortableClawAvatar,
  isSafeClawRelativePath,
  isValidClawTimezone,
  portableClawPathKey,
} from "./portability.js";
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
    (value) => value.length === value.trim().length,
    "Value must not have leading or trailing whitespace.",
  );
const optionalString = nonEmptyString.optional();
const agentId = nonEmptyString.regex(
  /^[a-z][a-z0-9_-]{0,63}$/,
  "Agent id must start with a lowercase letter and contain only lowercase letters, digits, underscores, or hyphens.",
);
const packageRelativePath = nonEmptyString.refine(isSafeClawRelativePath, {
  message:
    "Path must use forward slashes, be package-relative, and not contain traversal segments.",
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

const workspaceSchema = z
  .object({
    bootstrapFiles: bootstrapFilesSchema.optional().default({}),
    files: z
      .array(z.object({ source: packageRelativePath, path: packageRelativePath }).strict())
      .optional()
      .default([]),
  })
  .strict()
  .default({ bootstrapFiles: {}, files: [] });

const packageSchema = z
  .object({
    kind: z.enum(["skill", "plugin"]),
    source: z.literal("clawhub"),
    ref: nonEmptyString.refine(
      isCanonicalClawHubPackageName,
      "ClawHub package references must use their canonical lowercase name.",
    ),
    version: nonEmptyString.refine(
      isExactSemVer,
      "Package version must be exact semantic version.",
    ),
  })
  .strict();

const toolFilterSchema = z
  .object({
    include: z.array(nonEmptyString).min(1).optional(),
    exclude: z.array(nonEmptyString).min(1).optional(),
  })
  .strict()
  .superRefine((filter, context) => {
    for (const field of ["include", "exclude"] as const) {
      const seen = new Set<string>();
      for (const [index, value] of (filter[field] ?? []).entries()) {
        if (value.includes("?") || value.includes("[") || value.includes("]")) {
          context.addIssue({
            code: "custom",
            path: [field, index],
            message: "Tool filters support only exact names and * wildcards.",
          });
        }
        if (seen.has(value)) {
          context.addIssue({
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
  toolFilter: toolFilterSchema.optional(),
  timeout: z.number().finite().positive().optional(),
  connectTimeout: z.number().finite().positive().optional(),
};
const environmentReference = nonEmptyString.regex(
  /^\$\{[A-Z_][A-Z0-9_]*\}$/,
  "MCP environment values must be unresolved ${ENV_VAR} references.",
);

const stdioMcpServerSchema = z
  .object({
    command: nonEmptyString,
    transport: z.literal("stdio").optional(),
    args: z.array(nonEmptyString).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), environmentReference).optional(),
    ...mcpServerCommonShape,
  })
  .strict()
  .superRefine((server, context) => {
    if (isClawPackageManagerArtifactPinned(server.command, server.args ?? []) === false) {
      context.addIssue({
        code: "custom",
        path: ["args"],
        message: "Package-manager MCP commands must select one exact immutable package version.",
      });
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
  .superRefine((server, context) => {
    const url = new URL(server.url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "Remote MCP URLs must use HTTPS, except HTTP on an exact loopback host.",
      });
    }
    if (url.username || url.password || url.hash) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "Remote MCP URLs must not contain user information or fragments.",
      });
    }
  });

const cronJobSchema = z
  .object({
    id: agentId,
    name: optionalString,
    schedule: z.object({ cron: nonEmptyString, timezone: nonEmptyString }).strict(),
    session: z.enum(["main", "isolated"]),
    message: nonEmptyString,
    delivery: z
      .object({ mode: z.enum(["none", "announce"]), channel: z.literal("last").optional() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((job, context) => {
    if (job.schedule.cron.trim().split(/\s+/).length !== 5) {
      context.addIssue({
        code: "custom",
        path: ["schedule", "cron"],
        message: "Cron schedule must use exactly five fields.",
      });
    }
    if (!isValidClawTimezone(job.schedule.timezone)) {
      context.addIssue({
        code: "custom",
        path: ["schedule", "timezone"],
        message: "Invalid IANA timezone.",
      });
    } else {
      try {
        new Cron(job.schedule.cron, { timezone: job.schedule.timezone }).nextRun();
      } catch {
        context.addIssue({
          code: "custom",
          path: ["schedule", "cron"],
          message: "Invalid cron expression.",
        });
      }
    }
    if (
      (job.delivery?.mode === "none" && job.delivery.channel !== undefined) ||
      (job.delivery?.mode === "announce" && job.delivery.channel !== "last")
    ) {
      context.addIssue({
        code: "custom",
        path: ["delivery"],
        message: 'Delivery must be { mode: "none" } or { mode: "announce", channel: "last" }.',
      });
    }
  });

const manifestSchema = z
  .object({
    schemaVersion: z.literal(CLAW_SCHEMA_VERSION),
    agent: agentSchema,
    metadata: z.record(nonEmptyString, z.string()).optional().default({}),
    workspace: workspaceSchema.optional().default({ bootstrapFiles: {}, files: [] }),
    packages: z.array(packageSchema).optional().default([]),
    mcpServers: z
      .record(
        nonEmptyString.regex(/^[a-z][a-z0-9_-]{0,63}$/),
        z.union([stdioMcpServerSchema, remoteMcpServerSchema]),
      )
      .optional()
      .default({}),
    cronJobs: z.array(cronJobSchema).optional().default([]),
  })
  .strict()
  .superRefine((manifest, context) => {
    const workspaceTargets = new Set<string>();
    for (const name of CLAW_BOOTSTRAP_FILE_NAMES) {
      if (manifest.workspace.bootstrapFiles[name]) {
        workspaceTargets.add(portableClawPathKey(name));
      }
    }
    manifest.workspace.files.forEach((file, index) => {
      const destinationKey = portableClawPathKey(file.path);
      if (conflictsWithClawPath(workspaceTargets, destinationKey)) {
        context.addIssue({
          code: "custom",
          path: ["workspace", "files", index, "path"],
          message: `Workspace destination ${JSON.stringify(file.path)} is declared more than once.`,
        });
      }
      workspaceTargets.add(destinationKey);
    });

    const managedPaths = new Set(
      manifest.workspace.files.map((file) => portableClawPathKey(file.path)),
    );
    const avatar = manifest.agent.identity?.avatar;
    if (avatar && !/^data:/i.test(avatar) && !managedPaths.has(portableClawPathKey(avatar))) {
      context.addIssue({
        code: "custom",
        path: ["agent", "identity", "avatar"],
        message: "Workspace-relative avatar must match a workspace.files destination.",
      });
    }

    const packageKeys = new Set<string>();
    manifest.packages.forEach((pkg, index) => {
      const key = `${pkg.kind}:${pkg.source}:${pkg.ref.toLowerCase()}`;
      if (packageKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["packages", index],
          message: `Package ${JSON.stringify(pkg.ref)} is declared more than once for ${pkg.kind}.`,
        });
      }
      packageKeys.add(key);
    });

    const cronIds = new Set<string>();
    manifest.cronJobs.forEach((job, index) => {
      if (cronIds.has(job.id)) {
        context.addIssue({
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
