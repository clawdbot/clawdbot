import {
  buildChannelConfigSchema,
  buildCommonChannelAccountShape,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { BUZZ_CHANNEL_ID_PATTERN } from "./target.js";

const BuzzGroupConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
  })
  .strict();

const BuzzCommonAccountShape = buildCommonChannelAccountShape({
  groupPolicyDefault: true,
  omit: [
    "capabilities",
    "dmPolicy",
    "allowFrom",
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

const RawBuzzConfigSchema = z
  .object({
    name: BuzzCommonAccountShape.name,
    enabled: BuzzCommonAccountShape.enabled,
    configWrites: BuzzCommonAccountShape.configWrites,
    markdown: BuzzCommonAccountShape.markdown,
    relayUrl: z
      .string()
      .url()
      .and(z.string().regex(/^[wW][sS][sS]?:\/\//, "Buzz relay URL must use ws:// or wss://"))
      .optional(),
    privateKey: buildSecretInputSchema().optional(),
    authTag: buildSecretInputSchema().optional(),
    groupPolicy: BuzzCommonAccountShape.groupPolicy,
    groupAllowFrom: BuzzCommonAccountShape.groupAllowFrom,
    groups: z
      .record(
        z.string().regex(BUZZ_CHANNEL_ID_PATTERN, "Buzz group key must be a channel UUID"),
        BuzzGroupConfigSchema,
      )
      .optional(),
    defaultTo: BuzzCommonAccountShape.defaultTo,
  })
  .strict();

export const BuzzConfigSchema = buildChannelConfigSchema(RawBuzzConfigSchema);
export type BuzzConfigInput = z.input<typeof RawBuzzConfigSchema>;
export type BuzzConfig = z.output<typeof RawBuzzConfigSchema>;
