// Defines cloud-worker provider profile config parsing.
import { z } from "zod";
import { isPluginJsonValue } from "../plugins/host-hook-json.js";
import { isValidSecretRef } from "../secrets/ref-contract.js";
import { isSensitiveConfigPath } from "./sensitive-paths.js";
import type {
  CloudWorkerLifetimePolicyConfig,
  CloudWorkerProfileConfig,
  CloudWorkersConfig,
} from "./types.cloud-workers.js";
import { isSecretRef } from "./types.secrets.js";

type ConfigSchemaShape<T extends object> = {
  [Key in keyof T]-?: z.ZodType<T[Key]>;
};

const CloudWorkerLifetimePolicyShape = {
  idleTimeoutMinutes: z.number().int().positive().optional(),
  maxLifetimeMinutes: z.number().int().positive().optional(),
} satisfies ConfigSchemaShape<CloudWorkerLifetimePolicyConfig>;

const CloudWorkerLifetimePolicySchema = z.object(CloudWorkerLifetimePolicyShape).strict();

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
  provider: z.string().trim().min(1),
  install: z.enum(["bundle", "npm"]).optional().default("bundle"),
  settings: CloudWorkerSettingsSchema.optional(),
  lifetime: CloudWorkerLifetimePolicySchema.optional(),
} satisfies ConfigSchemaShape<CloudWorkerProfileConfig>;

const CloudWorkerProfileSchema = z.object(CloudWorkerProfileShape).strict();
const CloudWorkerProfileIdSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.trim(),
    "Worker profile ids must not contain outer whitespace",
  );

const CloudWorkersConfigShape = {
  profiles: z.record(CloudWorkerProfileIdSchema, CloudWorkerProfileSchema).optional(),
} satisfies ConfigSchemaShape<CloudWorkersConfig>;

export const CloudWorkersConfigSchema = z.object(CloudWorkersConfigShape).strict().optional();
