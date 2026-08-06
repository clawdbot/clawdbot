// Qa Channel helper module supports config schema behavior.
import {
  buildChannelConfigSchema,
  buildCommonChannelAccountShape,
  buildGroupEntrySchema,
  buildMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const QaChannelActionConfigSchema = z
  .object({
    messages: z.boolean().optional(),
    reactions: z.boolean().optional(),
    search: z.boolean().optional(),
    threads: z.boolean().optional(),
  })
  .strict();

const QaChannelGroupConfigSchema = buildGroupEntrySchema().omit({
  skills: true,
  enabled: true,
  allowFrom: true,
  systemPrompt: true,
});

const QaChannelCommonAccountShape = buildCommonChannelAccountShape({
  omit: [
    "capabilities",
    "markdown",
    "dmPolicy",
    "groupPolicy",
    "mentionPatterns",
    "contextVisibility",
    "historyLimit",
    "dmHistoryLimit",
    "dms",
    "textChunkLimit",
    "streaming",
    "heartbeatVisibility",
    "healthMonitor",
    "responsePrefix",
    "mediaMaxMb",
    "replyToMode",
  ],
});

const QaChannelAccountConfigSchema = z
  .object({
    name: QaChannelCommonAccountShape.name,
    enabled: QaChannelCommonAccountShape.enabled,
    configWrites: QaChannelCommonAccountShape.configWrites,
    baseUrl: z.string().url().optional(),
    botUserId: z.string().optional(),
    botDisplayName: z.string().optional(),
    pollTimeoutMs: z.number().int().min(100).max(30_000).optional(),
    allowFrom: QaChannelCommonAccountShape.allowFrom,
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    groupAllowFrom: QaChannelCommonAccountShape.groupAllowFrom,
    groups: z.record(z.string(), QaChannelGroupConfigSchema).optional(),
    defaultTo: QaChannelCommonAccountShape.defaultTo,
    actions: QaChannelActionConfigSchema.optional(),
  })
  .strict();

const QaChannelConfigSchema = buildMultiAccountChannelSchema(QaChannelAccountConfigSchema, {
  accountSchema: QaChannelAccountConfigSchema.partial(),
});

export const qaChannelPluginConfigSchema = buildChannelConfigSchema(QaChannelConfigSchema);
