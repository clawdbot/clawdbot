// Line helper module supports config schema behavior.
import {
  ContextVisibilityModeSchema,
  DmPolicySchema,
  GroupPolicySchema,
  buildChannelConfigSchema,
  buildGroupEntrySchema,
  buildMultiAccountChannelSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { requireChannelOpenAllowFrom } from "openclaw/plugin-sdk/extension-shared";
import { z } from "zod";

const ThreadBindingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    idleHours: z.number().optional(),
    maxAgeHours: z.number().optional(),
    spawnSessions: z.boolean().optional(),
    defaultSpawnContext: z.enum(["isolated", "fork"]).optional(),
  })
  .strict();

const LineCommonConfigSchemaBase = z.object({
  enabled: z.boolean().optional(),
  configWrites: z.boolean().optional(),
  joinIntro: z.boolean().optional(),
  historyLimit: z.number().int().min(0).optional(),
  channelAccessToken: z.string().optional(),
  channelSecret: z.string().optional(),
  tokenFile: z.string().optional(),
  secretFile: z.string().optional(),
  name: z.string().optional(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  dmPolicy: DmPolicySchema.optional().default("pairing"),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  contextVisibility: ContextVisibilityModeSchema.optional(),
  responsePrefix: z.string().optional(),
  mediaMaxMb: z.number().optional(),
  webhookPath: z.string().optional(),
  threadBindings: ThreadBindingsSchema.optional(),
});

const LineGroupConfigSchema = buildGroupEntrySchema().omit({
  tools: true,
  toolsBySender: true,
});

const LineAccountConfigSchema = LineCommonConfigSchemaBase.extend({
  groups: z.record(z.string(), LineGroupConfigSchema.optional()).optional(),
}).strict();

export const LineConfigSchema = buildMultiAccountChannelSchema(LineAccountConfigSchema, {
  optionalAccount: true,
  refine: (value, ctx) => {
    requireChannelOpenAllowFrom({
      channel: "line",
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      requireOpenAllowFrom,
    });
  },
});

export const LineChannelConfigSchema = buildChannelConfigSchema(LineConfigSchema, {
  uiHints: {
    joinIntro: {
      label: "LINE Group Join Introduction",
      help: "Post one brief introduction when the bot joins an allowed LINE group or multi-person room (default: true). Account settings override the channel-wide setting.",
    },
  },
});

export type LineConfigSchemaType = z.infer<typeof LineConfigSchema>;
