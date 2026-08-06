// Qqbot helper module supports config schema behavior.
import {
  buildChannelConfigSchema,
  buildCommonChannelAccountShape,
  buildGroupEntrySchema,
  buildMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const AudioFormatPolicySchema = z
  .object({
    sttDirectFormats: z.array(z.string()).optional(),
    uploadDirectFormats: z.array(z.string()).optional(),
    transcodeEnabled: z.boolean().optional(),
  })
  .optional();

const QQBotSttSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: z.string().optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    model: z.string().optional(),
  })
  .strict()
  .optional();

// Nested streaming config. Legacy scalar booleans and the `c2cStreamApi` key
// migrate to this shape via `openclaw doctor --fix`.
const QQBotStreamingSchema = z
  .object({
    /** "partial" (default) enables block streaming; "off" disables it. */
    mode: z.enum(["off", "partial"]).default("partial"),
    /** Use QQ's official C2C `stream_messages` API for DM replies. */
    nativeTransport: z.boolean().optional(),
  })
  .strict()
  .optional();

const QQBotExecApprovalsSchema = z
  .object({
    enabled: z.union([z.boolean(), z.literal("auto")]).optional(),
    approvers: z.array(z.string()).optional(),
    agentFilter: z.array(z.string()).optional(),
    sessionFilter: z.array(z.string()).optional(),
    target: z.enum(["dm", "channel", "both"]).optional(),
  })
  .strict()
  .optional();

const QQBotDmPolicySchema = z.enum(["open", "allowlist", "disabled"]).optional();
const QQBotGroupCommandLevelSchema = z.enum(["all", "safety", "strict"]).optional();

const QQBotGroupSchema = buildGroupEntrySchema({
  commandLevel: QQBotGroupCommandLevelSchema,
  ignoreOtherMentions: z.boolean().optional(),
  historyLimit: z.number().optional(),
  name: z.string().optional(),
  prompt: z.string().optional(),
}).omit({ skills: true, enabled: true, allowFrom: true, systemPrompt: true });

const QQBotGroupsSchema = z.record(z.string(), QQBotGroupSchema).optional();

const QQBotCommonAccountShape = buildCommonChannelAccountShape({
  omit: [
    "capabilities",
    "markdown",
    "configWrites",
    "dmPolicy",
    "defaultTo",
    "mentionPatterns",
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

const QQBotAccountSchema = z
  .object({
    enabled: QQBotCommonAccountShape.enabled,
    name: QQBotCommonAccountShape.name,
    appId: z.string().optional(),
    clientSecret: buildSecretInputSchema().optional(),
    clientSecretFile: z.string().optional(),
    allowFrom: QQBotCommonAccountShape.allowFrom,
    groupAllowFrom: QQBotCommonAccountShape.groupAllowFrom,
    dmPolicy: QQBotDmPolicySchema,
    groupPolicy: QQBotCommonAccountShape.groupPolicy,
    contextVisibility: QQBotCommonAccountShape.contextVisibility,
    systemPrompt: z.string().optional(),
    markdownSupport: z.boolean().optional(),
    audioFormatPolicy: AudioFormatPolicySchema,
    urlDirectUpload: z.boolean().optional(),
    upgradeUrl: z.string().optional(),
    upgradeMode: z.enum(["doc", "hot-reload"]).optional(),
    streaming: QQBotStreamingSchema,
    execApprovals: QQBotExecApprovalsSchema,
    groups: QQBotGroupsSchema,
  })
  .passthrough();

const QQBotConfigSchema = buildMultiAccountChannelSchema(
  QQBotAccountSchema.extend({
    stt: QQBotSttSchema,
  }).passthrough(),
  {
    accountSchema: QQBotAccountSchema,
    accountsMode: "catchall",
  },
);
export const qqbotChannelConfigSchema = buildChannelConfigSchema(QQBotConfigSchema);
