import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const TelegramUserAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    apiId: z.number().int().positive().optional(),
    apiHash: z.string().optional(),
    dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
    allowFrom: z.array(allowFromEntry).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    mediaMaxMb: z.number().positive().optional(),
  })
  .strict();

export const TelegramUserConfigSchema = TelegramUserAccountSchema.extend({
  accounts: z.record(z.string(), TelegramUserAccountSchema.optional()).optional(),
});
