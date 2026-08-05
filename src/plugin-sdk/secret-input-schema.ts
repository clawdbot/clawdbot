// Secret input schema helpers validate plugin-declared credential prompts and storage metadata.
import { z } from "zod";
import { ENV_SECRET_REF_ID_RE } from "../config/types.secrets.js";
import { sensitive } from "../config/zod-schema.sensitive.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  isValidFileSecretRefId,
  SECRET_PROVIDER_ALIAS_PATTERN,
} from "../secrets/ref-contract.js";

/**
 * Returns the shared secret-input schema for plaintext values and env/file/exec refs.
 * Reusing this singleton preserves sensitive-path registration for config redaction.
 */
export function buildSecretInputSchema() {
  return secretInputSchema;
}

/** Register a plugin-owned config schema leaf for redaction in host config projections. */
export function registerSensitiveConfigSchema<TSchema extends z.ZodType>(schema: TSchema): TSchema {
  sensitive.add(schema);
  return schema;
}

const providerSchema = z
  .string()
  .regex(
    SECRET_PROVIDER_ALIAS_PATTERN,
    'Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").',
  );

// Singleton registered with the sensitive registry so that mapSensitivePaths
// marks every config field using this schema as sensitive (redacted).
const secretInputSchema = z
  .union([
    z.string(),
    z.discriminatedUnion("source", [
      z
        .object({
          source: z.literal("env"),
          provider: providerSchema,
          id: z
            .string()
            .regex(
              ENV_SECRET_REF_ID_RE,
              'Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: "OPENAI_API_KEY").',
            ),
        })
        .strict(),
      z
        .object({
          source: z.literal("file"),
          provider: providerSchema,
          id: z
            .string()
            .refine(
              isValidFileSecretRefId,
              'File secret reference id must be an absolute JSON pointer (example: "/providers/openai/apiKey"), or "value" for singleValue mode.',
            ),
        })
        .strict(),
      z
        .object({
          source: z.literal("exec"),
          provider: providerSchema,
          id: z.string().refine(isValidExecSecretRefId, formatExecSecretRefIdValidationMessage()),
        })
        .strict(),
    ]),
  ])
  .register(sensitive);
