// OpenClaw policy layered over the portable Claw v1 manifest contract.
import { parseClawManifest as parsePortableClawManifest } from "@openclaw/claw-spec";
import { z } from "zod";
import { resolveToolProfilePolicy } from "../agents/tool-policy-shared.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { isDangerousHostEnvVarName } from "../infra/host-env-security.js";
import type { ClawDiagnostic, ClawManifest, ClawOpenClawProfile } from "./types.js";

const nonEmptyString = z
  .string()
  .min(1)
  .refine(
    (value) => value.length === value.trim().length,
    "Value must not have leading or trailing whitespace.",
  );

const openClawProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    agent: z
      .object({
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
          .superRefine((tools, context) => {
            if (tools.allow && tools.alsoAllow) {
              context.addIssue({
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
              .superRefine((search, context) => {
                if (
                  search.sources?.includes("sessions") &&
                  search.rememberAcrossConversations !== true
                ) {
                  context.addIssue({
                    code: "custom",
                    path: ["rememberAcrossConversations"],
                    message:
                      "The sessions source requires rememberAcrossConversations: true in the OpenClaw profile.",
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
                  .refine((value) => {
                    try {
                      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
                      return true;
                    } catch {
                      return false;
                    }
                  }, "Invalid IANA timezone.")
                  .optional(),
              })
              .strict()
              .optional(),
            lightContext: z.boolean().optional(),
            isolatedSession: z.boolean().optional(),
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
      .strict(),
  })
  .strict();

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
  const parsed = parsePortableClawManifest(value);
  if (!parsed.ok) {
    return parsed;
  }
  const diagnostics: ClawDiagnostic[] = [];
  for (const [serverName, server] of Object.entries(parsed.manifest.mcpServers)) {
    if (!("command" in server)) {
      continue;
    }
    for (const key of Object.keys(server.env ?? {})) {
      if (isDangerousHostEnvVarName(key)) {
        diagnostics.push({
          level: "error",
          code: "invalid_manifest",
          phase: "schema",
          path: `$.mcpServers.${serverName}.env.${key}`,
          message: "Environment key is blocked by the spawned-process safety policy.",
        });
      }
    }
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : parsed;
}

export function parseClawOpenClawProfile(
  value: unknown,
):
  | { ok: true; profile: ClawOpenClawProfile; diagnostics: ClawDiagnostic[] }
  | { ok: false; diagnostics: ClawDiagnostic[] } {
  const parsed = openClawProfileSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, diagnostics: diagnosticsFromZodError(parsed.error) };
  }
  return {
    ok: true,
    profile: parsed.data as ClawOpenClawProfile,
    diagnostics: [],
  };
}
