import { z } from "zod";

export const codexSessionCatalogConfigSchema = z
  .object({ enabled: z.boolean().optional() })
  .strict();

export const codexDiscoveryConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: z.number().positive().optional(),
  })
  .strict();
