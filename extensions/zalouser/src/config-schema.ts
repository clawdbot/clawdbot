// Zalouser helper module supports config schema behavior.
import {
  buildCommonChannelAccountShape,
  buildMultiAccountChannelSchema,
  buildGroupEntrySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const groupConfigSchema = buildGroupEntrySchema()
  .omit({ toolsBySender: true, skills: true, allowFrom: true, systemPrompt: true })
  .strip();

const ZalouserCommonAccountShape = buildCommonChannelAccountShape({
  groupPolicyDefault: true,
  omit: [
    "capabilities",
    "defaultTo",
    "mentionPatterns",
    "contextVisibility",
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

const zalouserAccountSchema = z.object({
  name: ZalouserCommonAccountShape.name,
  enabled: ZalouserCommonAccountShape.enabled,
  configWrites: ZalouserCommonAccountShape.configWrites,
  markdown: ZalouserCommonAccountShape.markdown,
  profile: z.string().optional(),
  dangerouslyAllowNameMatching: z.boolean().optional(),
  dmPolicy: ZalouserCommonAccountShape.dmPolicy,
  allowFrom: ZalouserCommonAccountShape.allowFrom,
  historyLimit: ZalouserCommonAccountShape.historyLimit,
  groupAllowFrom: ZalouserCommonAccountShape.groupAllowFrom,
  groupPolicy: ZalouserCommonAccountShape.groupPolicy,
  groups: z.object({}).catchall(groupConfigSchema).optional(),
  messagePrefix: z.string().optional(),
  responsePrefix: ZalouserCommonAccountShape.responsePrefix,
});

export const ZalouserConfigSchema = buildMultiAccountChannelSchema(zalouserAccountSchema, {
  accountsMode: "catchall",
});
