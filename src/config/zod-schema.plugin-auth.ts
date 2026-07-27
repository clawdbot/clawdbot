import { z } from "zod";

export const PluginEntryAuthSchema = z
  .object({
    delegatedAccess: z
      .object({
        enabled: z.boolean().optional(),
        providers: z.array(z.string()).optional(),
        audiences: z.array(z.string()).optional(),
        scopes: z.array(z.string()).optional(),
        chatTypes: z.array(z.enum(["direct", "group", "channel"])).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
