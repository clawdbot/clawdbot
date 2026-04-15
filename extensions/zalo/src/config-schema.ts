import {
  AllowFromListSchema,
  buildCatchallMultiAccountChannelSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";
import { buildSecretInputSchema } from "./secret-input.js";

const zaloAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
  botToken: buildSecretInputSchema().optional(),
  tokenFile: z.string().optional(),
  webhookUrl: z.string().optional(),
  webhookSecret: buildSecretInputSchema().optional(),
  webhookPath: z.string().optional(),
  dmPolicy: DmPolicySchema.optional(),
  allowFrom: AllowFromListSchema,
  groupPolicy: GroupPolicySchema.optional(),
  groupAllowFrom: AllowFromListSchema,
  mediaMaxMb: z.number().optional(),
  proxy: z.string().optional(),
  responsePrefix: z.string().optional(),
});

export const ZaloConfigSchema = buildCatchallMultiAccountChannelSchema(zaloAccountSchema);
