// Zalo helper module supports config schema behavior.
import {
  buildCommonChannelAccountShape,
  buildMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";
import { buildSecretInputSchema } from "./secret-input.js";

const ZaloCommonAccountShape = buildCommonChannelAccountShape({
  omit: [
    "capabilities",
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

const zaloAccountSchema = z.object({
  name: ZaloCommonAccountShape.name,
  enabled: ZaloCommonAccountShape.enabled,
  configWrites: ZaloCommonAccountShape.configWrites,
  markdown: ZaloCommonAccountShape.markdown,
  botToken: buildSecretInputSchema().optional(),
  tokenFile: z.string().optional(),
  webhookUrl: z.string().optional(),
  webhookSecret: buildSecretInputSchema().optional(),
  webhookPath: z.string().optional(),
  dmPolicy: ZaloCommonAccountShape.dmPolicy,
  allowFrom: ZaloCommonAccountShape.allowFrom,
  groupPolicy: ZaloCommonAccountShape.groupPolicy,
  groupAllowFrom: ZaloCommonAccountShape.groupAllowFrom,
  mediaMaxMb: z.number().optional(),
  proxy: z.string().optional(),
  responsePrefix: ZaloCommonAccountShape.responsePrefix,
});

export const ZaloConfigSchema = buildMultiAccountChannelSchema(zaloAccountSchema, {
  accountsMode: "catchall",
});
