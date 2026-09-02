import { z } from "zod";

const codexSessionCatalogHomeSchema = z.union([
  z.string().trim().min(1),
  z.object({ path: z.string().trim().min(1), label: z.string().trim().min(1).optional() }).strict(),
]);

export const codexSessionCatalogConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    homes: z.array(codexSessionCatalogHomeSchema).optional(),
  })
  .strict();

export const codexDiscoveryConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: z.number().positive().optional(),
  })
  .strict();
