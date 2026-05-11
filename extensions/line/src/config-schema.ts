import {
  buildChannelConfigSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { requireChannelOpenAllowFrom } from "openclaw/plugin-sdk/extension-shared";
import { z } from "zod";

const DmPolicySchema = z.enum(["open", "allowlist", "pairing", "disabled"]);
const GroupPolicySchema = z.enum(["open", "allowlist", "disabled"]);
const ThreadBindingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    idleHours: z.number().optional(),
    maxAgeHours: z.number().optional(),
    spawnSessions: z.boolean().optional(),
    defaultSpawnContext: z.enum(["isolated", "fork"]).optional(),
    spawnSubagentSessions: z.boolean().optional(),
    spawnAcpSessions: z.boolean().optional(),
  })
  .strict();

const LineCommonConfigSchemaBase = z.object({
  enabled: z.boolean().optional(),
  channelAccessToken: z.string().optional(),
  channelSecret: z.string().optional(),
  tokenFile: z.string().optional(),
  secretFile: z.string().optional(),
  name: z.string().optional(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  dmPolicy: DmPolicySchema.optional().default("pairing"),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  responsePrefix: z.string().optional(),
  mediaMaxMb: z.number().optional(),
  webhookPath: z.string().optional(),
  threadBindings: ThreadBindingsSchema.optional(),
});

const LineGroupConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    requireMention: z.boolean().optional(),
    systemPrompt: z.string().optional(),
    skills: z.array(z.string()).optional(),
  })
  .strict();

const LineAccountConfigSchema = LineCommonConfigSchemaBase.extend({
  groups: z.record(z.string(), LineGroupConfigSchema.optional()).optional(),
})
  .strict()
  .superRefine((value, ctx) => {
    requireChannelOpenAllowFrom({
      channel: "line",
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      requireOpenAllowFrom,
    });
  });

export const LineConfigSchema = LineCommonConfigSchemaBase.extend({
  accounts: z.record(z.string(), LineAccountConfigSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
  groups: z.record(z.string(), LineGroupConfigSchema.optional()).optional(),
})
  .strict()
  .superRefine((value, ctx) => {
    requireChannelOpenAllowFrom({
      channel: "line",
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      requireOpenAllowFrom,
    });
  });

export const LineChannelConfigSchema = buildChannelConfigSchema(LineConfigSchema);

export type LineConfigSchemaType = z.infer<typeof LineConfigSchema>;
