import {
  buildChannelConfigSchema,
  buildMultiAccountChannelSchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { BUZZ_CHANNEL_ID_PATTERN } from "./target.js";

const BuzzGroupConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
  })
  .strict();

const BuzzAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    markdown: MarkdownConfigSchema.optional(),
    relayUrl: z
      .string()
      .url()
      .and(z.string().regex(/^[wW][sS][sS]?:\/\//, "Buzz relay URL must use ws:// or wss://"))
      .optional(),
    privateKey: buildSecretInputSchema().optional(),
    authTag: buildSecretInputSchema().optional(),
    groupPolicy: GroupPolicySchema.optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z
      .record(
        z.string().regex(BUZZ_CHANNEL_ID_PATTERN, "Buzz group key must be a channel UUID"),
        BuzzGroupConfigSchema,
      )
      .optional(),
    defaultTo: z.string().optional(),
  })
  .strict();

const RawBuzzConfigSchema = buildMultiAccountChannelSchema(
  BuzzAccountConfigSchema.extend({
    markdown: MarkdownConfigSchema,
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  }),
  { accountSchema: BuzzAccountConfigSchema },
);

export const BuzzConfigSchema = buildChannelConfigSchema(RawBuzzConfigSchema);
export type BuzzConfigInput = z.input<typeof RawBuzzConfigSchema>;
export type BuzzConfig = z.output<typeof RawBuzzConfigSchema>;
