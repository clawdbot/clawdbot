// Line helper module supports config schema behavior.
import {
  buildChannelConfigSchema,
  buildCommonChannelAccountShape,
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

const LineCommonAccountShape = buildCommonChannelAccountShape({
  useDefaults: true,
  omit: [
    "capabilities",
    "markdown",
    "defaultTo",
    "mentionPatterns",
    "contextVisibility",
    "historyLimit",
    "dmHistoryLimit",
    "dms",
    "textChunkLimit",
    "streaming",
    "heartbeatVisibility",
    "healthMonitor",
    "mediaMaxMb",
    "replyToMode",
  ],
});

const LineCommonConfigSchemaBase = z.object({
  enabled: LineCommonAccountShape.enabled,
  configWrites: LineCommonAccountShape.configWrites,
  channelAccessToken: z.string().optional(),
  channelSecret: z.string().optional(),
  tokenFile: z.string().optional(),
  secretFile: z.string().optional(),
  name: LineCommonAccountShape.name,
  allowFrom: LineCommonAccountShape.allowFrom,
  groupAllowFrom: LineCommonAccountShape.groupAllowFrom,
  dmPolicy: LineCommonAccountShape.dmPolicy,
  groupPolicy: LineCommonAccountShape.groupPolicy,
  responsePrefix: LineCommonAccountShape.responsePrefix,
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

export const LineChannelConfigSchema = buildChannelConfigSchema(LineConfigSchema);

export type LineConfigSchemaType = z.infer<typeof LineConfigSchema>;
