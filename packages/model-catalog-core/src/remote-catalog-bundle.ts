import { z } from "zod";
import {
  MODEL_CATALOG_APIS,
  MODEL_CATALOG_MAX_CONTEXT_WINDOWS,
  MODEL_CATALOG_THINKING_LEVELS,
} from "./model-catalog-types.js";
import type { ModelCatalogProvider } from "./model-catalog-types.js";

export const REMOTE_CATALOG_MAX_FUTURE_SKEW_MS = 24 * 60 * 60_000;

const stringMapSchema = z.record(z.string(), z.string());
const pricingTierSchema = z
  .object({
    input: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
    cacheRead: z.number().finite().nonnegative(),
    cacheWrite: z.number().finite().nonnegative(),
    range: z.union([
      z.tuple([z.number().finite().nonnegative()]),
      z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()]),
    ]),
  })
  .strict();

const costSchema = z
  .object({
    input: z.number().finite().nonnegative().optional(),
    output: z.number().finite().nonnegative().optional(),
    cacheRead: z.number().finite().nonnegative().optional(),
    cacheWrite: z.number().finite().nonnegative().optional(),
    tieredPricing: z.array(pricingTierSchema).optional(),
  })
  .strict();

const hostedPricingSchema = z
  .object({
    input: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
    cacheRead: z.number().finite().nonnegative().optional(),
    cacheWrite: z.number().finite().nonnegative().optional(),
    tieredPricing: z.array(pricingTierSchema).optional(),
  })
  .strict();

export type RemoteModelCatalogPricing = z.infer<typeof hostedPricingSchema>;

const contextWindowOptionSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    contextWindow: z.number().int().positive(),
  })
  .strict();

const modelSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().optional(),
    api: z.enum(MODEL_CATALOG_APIS).optional(),
    baseUrl: z.string().optional(),
    headers: stringMapSchema.optional(),
    input: z.array(z.enum(["text", "image", "document"])).optional(),
    reasoning: z.boolean().optional(),
    contextWindow: z.number().finite().positive().optional(),
    contextWindows: z
      .array(contextWindowOptionSchema)
      .max(MODEL_CATALOG_MAX_CONTEXT_WINDOWS)
      .optional(),
    contextWindowDefault: z.string().trim().min(1).optional(),
    contextTokens: z.number().int().positive().optional(),
    maxTokens: z.number().finite().positive().optional(),
    thinkingLevelMap: z
      .partialRecord(z.enum(MODEL_CATALOG_THINKING_LEVELS), z.string().nullable())
      .optional(),
    cost: costSchema.optional(),
    compat: z.record(z.string(), z.unknown()).optional(),
    mediaInput: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(["available", "preview", "deprecated", "disabled"]).optional(),
    statusReason: z.string().optional(),
    replaces: z.array(z.string()).optional(),
    replacedBy: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .superRefine((model, context) => {
    if (
      model.contextWindowDefault &&
      !model.contextWindows?.some((option) => option.id === model.contextWindowDefault)
    ) {
      context.addIssue({
        code: "custom",
        message: "contextWindowDefault must reference a declared contextWindows option",
        path: ["contextWindowDefault"],
      });
    }
  });

export const remoteModelCatalogProviderSchema = z
  .object({
    baseUrl: z.string().optional(),
    api: z.enum(MODEL_CATALOG_APIS).optional(),
    headers: stringMapSchema.optional(),
    defaultModel: z.string().optional(),
    defaultUtilityModel: z.string().optional(),
    models: z.array(modelSchema).min(1),
  })
  .strict()
  .superRefine((provider, context) => {
    const seen = new Set<string>();
    for (const [index, model] of provider.models.entries()) {
      if (seen.has(model.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate model id: ${model.id}`,
          path: ["models", index, "id"],
        });
      }
      seen.add(model.id);
    }
  });

export const remoteModelCatalogBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z
      .number()
      .int()
      .positive()
      .refine((value) => value <= Date.now() + REMOTE_CATALOG_MAX_FUTURE_SKEW_MS, {
        message: "generatedAt is implausibly far in the future",
      }),
    minVersion: z.string().trim().min(1).optional(),
    sourceCommit: z.string().trim().min(1),
    providers: z.record(z.string().trim().min(1), remoteModelCatalogProviderSchema),
    pricing: z.record(z.string().trim().min(1), hostedPricingSchema).optional(),
  })
  .strict();

export type RemoteModelCatalogBundle = Omit<
  z.infer<typeof remoteModelCatalogBundleSchema>,
  "providers"
> & {
  providers: Record<string, ModelCatalogProvider>;
};

export function parseRemoteModelCatalogBundle(value: unknown): RemoteModelCatalogBundle {
  return remoteModelCatalogBundleSchema.parse(value) as RemoteModelCatalogBundle;
}

function stripRemoteTransportOverrides(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripRemoteTransportOverrides);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "baseUrl" && key !== "headers")
      .map(([key, entry]) => [key, stripRemoteTransportOverrides(entry)]),
  );
}

/** Removes every transport endpoint/header override before remote data reaches persistence. */
export function sanitizeRemoteModelCatalogBundle(
  bundle: RemoteModelCatalogBundle,
): RemoteModelCatalogBundle {
  return stripRemoteTransportOverrides(bundle) as RemoteModelCatalogBundle;
}

export function validateAndSanitizeRemoteModelCatalogBundle(
  value: unknown,
): RemoteModelCatalogBundle {
  return sanitizeRemoteModelCatalogBundle(parseRemoteModelCatalogBundle(value));
}
