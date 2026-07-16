import {
  AllowFromListSchema,
  buildCatchallMultiAccountChannelSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ToolPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";

const groupConfigSchema = z.object({
  enabled: z.boolean().optional(),
  requireMention: z.boolean().optional(),
  tools: ToolPolicySchema,
});

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

export const ZalouserConfigSchema = buildCatchallMultiAccountChannelSchema(zalouserAccountSchema);
