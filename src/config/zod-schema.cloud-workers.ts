// Defines cloud-worker provider profile config parsing.
import { z } from "zod";
import { parseDurationMs } from "../cli/parse-duration.js";
import { isPluginJsonValue } from "../plugins/host-hook-json.js";
import { isValidSecretRef } from "../secrets/ref-contract.js";
import { normalizeCloudRepo } from "./cloud-worker-project-profiles.js";
import { type ConfigSchemaShape, projectConfigFieldMetadata } from "./schema.field-metadata.js";
import { isSensitiveConfigPath } from "./sensitive-paths.js";
import type { CloudWorkerProfileConfig, CloudWorkersConfig } from "./types.cloud-workers.js";
import { isSecretRef } from "./types.secrets.js";
import { configUiMetadata } from "./zod-schema.sensitive.js";

export function validateCloudWorkerProfileSettings(value: unknown): string | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !isPluginJsonValue(value)
  ) {
    return "Worker profile settings must be bounded finite JSON";
  }
  const visit = (entry: unknown): string | undefined => {
    if (Array.isArray(entry)) {
      return entry.map(visit).find((error) => error !== undefined);
    }
    if (typeof entry !== "object" || entry === null) {
      return undefined;
    }
    for (const [key, child] of Object.entries(entry)) {
      const baseKey = key.replace(/ref$/i, "");
      const isSensitive =
        key.toLowerCase() === "keyref" ||
        isSensitiveConfigPath(key) ||
        (baseKey !== key && isSensitiveConfigPath(baseKey));
      if (isSensitive) {
        if (!isSecretRef(child) || !isValidSecretRef(child)) {
          return `Worker profile ${key} must use a SecretRef`;
        }
        continue;
      }
      const error = visit(child);
      if (error) {
        return error;
      }
    }
    return undefined;
  };
  return visit(value);
}

const CloudWorkerSettingsSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const message = validateCloudWorkerProfileSettings(value);
  if (message) {
    ctx.addIssue({ code: "custom", message });
  }
});

const CloudWorkerProfileShape = {
  provider: z.string().trim().min(1).register(configUiMetadata, {
    label: "Cloud Worker Provider",
    help: "Worker provider id registered by a plugin. The configured plugin must expose this id before the gateway can provision environments from the profile.",
  }),
  install: z.enum(["bundle", "npm"]).optional().default("bundle").register(configUiMetadata, {
    label: "Cloud Worker Install Method",
    help: 'Worker installation method: "bundle" (default) transfers the gateway\'s content-hashed installed build and supports released, development, and unreleased versions; "npm" installs the exact gateway version and is available only when that version is released.',
  }),
  suspendAfter: z
    .string()
    .refine((value) => {
      try {
        return /(?:ms|s|m|h|d)$/i.test(value) && parseDurationMs(value) >= 60_000;
      } catch {
        return false;
      }
    }, "Worker profile suspendAfter must be a duration of at least 1m")
    .optional()
    .register(configUiMetadata, {
      label: "Cloud Worker Idle Suspend Duration",
      help: "Automatically reclaims an idle cloud worker after this duration, such as 45m or 2h; the next message provisions a replacement. Minimum: 1m. Leave unset to keep workers running.",
    }),
  settings: CloudWorkerSettingsSchema.optional().register(configUiMetadata, {
    label: "Cloud Worker Provider Settings",
    help: "Provider-owned settings validated by the selected plugin. Use SecretRef objects for secret-bearing values; opaque settings do not gain automatic secret resolution.",
  }),
} satisfies ConfigSchemaShape<CloudWorkerProfileConfig>;

const CloudWorkerProfileSchema = z
  .object(CloudWorkerProfileShape)
  .strict()
  .register(configUiMetadata, {
    label: "Cloud Worker Profile",
    help: "One cloud worker profile selected by name when creating an environment. Keep provider credentials in supported references rather than embedding secret material in this block.",
  });
const CloudWorkerProfileIdSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim(),
    "Worker profile ids must not contain outer whitespace",
  );
const CloudWorkerProjectKeySchema = z
  .string()
  .min(1)
  .refine(
    (value) => normalizeCloudRepo(`https://${value}`) === value,
    "Project profile keys must use lowercase host/owner/repo identities without trailing .git",
  );
const CloudWorkerProjectProfileSchema = CloudWorkerProfileIdSchema.register(configUiMetadata, {
  label: "Cloud Worker Project Profile",
  help: "Cloud worker profile name used by default when a session worktree's origin matches this repository identity.",
});

const CloudWorkersConfigShape = {
  desktop: z.boolean().optional().register(configUiMetadata, {
    label: "Cloud Worker Desktop (Labs)",
    help: "Enables the experimental worker.desktop.observe surface and Control UI Desktop panel for desktop-capable cloud worker environments.",
  }),
  projectProfiles: z
    .record(CloudWorkerProjectKeySchema, CloudWorkerProjectProfileSchema)
    .optional()
    .register(configUiMetadata, {
      label: "Cloud Worker Project Profiles",
      help: "Default cloud worker profile names keyed by normalized lowercase repository identity (host/owner/repo). Explicit dispatch profile ids take precedence.",
    }),
  profiles: z
    .record(CloudWorkerProfileIdSchema, CloudWorkerProfileSchema)
    .optional()
    .register(configUiMetadata, {
      label: "Cloud Worker Profiles",
      help: "Named cloud worker profiles. Each profile selects a worker provider registered by a plugin and carries provider-owned settings.",
    }),
} satisfies ConfigSchemaShape<CloudWorkersConfig>;

export const CloudWorkersConfigSchema = z.object(CloudWorkersConfigShape).strict().optional();

export const { labels: CLOUD_WORKER_FIELD_LABELS, help: CLOUD_WORKER_FIELD_HELP } =
  projectConfigFieldMetadata(CloudWorkersConfigSchema, "cloudWorkers");
