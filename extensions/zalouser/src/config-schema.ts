// Zalouser helper module supports config schema behavior.
import {
  AllowFromListSchema,
  buildMultiAccountChannelSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  buildGroupEntrySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const groupConfigSchema = buildGroupEntrySchema()
  .omit({ toolsBySender: true, skills: true, allowFrom: true, systemPrompt: true })
  .strip();

const zalouserAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
  profile: z.string().optional(),
  dangerouslyAllowNameMatching: z.boolean().optional(),
  dmPolicy: DmPolicySchema.optional(),
  allowFrom: AllowFromListSchema,
  historyLimit: z.number().int().min(0).optional(),
  groupAllowFrom: AllowFromListSchema,
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  groups: z.object({}).catchall(groupConfigSchema).optional(),
  messagePrefix: z.string().optional(),
  responsePrefix: z.string().optional(),
});

export const ZalouserConfigSchema = buildMultiAccountChannelSchema(zalouserAccountSchema, {
  accountsMode: "catchall",
});
