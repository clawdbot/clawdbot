// Defines allow/deny list Zod schema fragments.
import { z } from "zod";

const AllowDenyActionSchema = z.union([z.literal("allow"), z.literal("deny")]);

const AllowDenyChatTypeSchema = z
  .union([z.literal("direct"), z.literal("group"), z.literal("channel")])
  .optional();

export function createAllowDenyChannelRulesSchema() {
  return z
    .object({
      default: AllowDenyActionSchema.optional(),
      rules: z
        .array(
          z
            .object({
              action: AllowDenyActionSchema,
              match: z
                .object({
                  channel: z.string().optional(),
                  chatType: AllowDenyChatTypeSchema,
                  keyPrefix: z.string().optional(),
                  rawKeyPrefix: z.string().optional(),
                })
                .strict()
                .optional(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict()
    .optional();
}
