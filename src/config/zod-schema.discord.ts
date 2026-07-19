// Defines shared Discord config schema fragments.
import { z } from "zod";

export const DiscordIdSchema = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Discord ID "${String(value)}" is not a valid non-negative safe integer. ` +
            `Wrap it in quotes in your config file.`,
        });
        return z.NEVER;
      }
      return String(value);
    }
    return value;
  })
  .pipe(z.string());

export const DiscordIdListSchema = z.array(DiscordIdSchema);
export const DiscordSnowflakeStringSchema = z
  .string()
  .regex(/^\d+$/, "Discord user ID must be numeric");

export const DiscordDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    groupEnabled: z.boolean().optional(),
    groupChannels: DiscordIdListSchema.optional(),
  })
  .strict();

export const DiscordPresenceEventsSchema = z
  .object({
    enabled: z.boolean().optional(),
    channelId: DiscordSnowflakeStringSchema,
    users: z.array(DiscordSnowflakeStringSchema).optional(),
    reconnectSuppressSeconds: z.number().int().min(0).optional(),
    burstLimit: z.number().int().positive().optional(),
    burstWindowSeconds: z.number().int().positive().optional(),
  })
  .strict();
