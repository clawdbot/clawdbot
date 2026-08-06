// Nextcloud Talk helper module supports config schema behavior.
import {
  buildCommonChannelAccountShape,
  buildGroupEntrySchema,
  buildMultiAccountChannelSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { requireChannelOpenAllowFrom } from "openclaw/plugin-sdk/extension-shared";
import { z } from "zod";
import { buildSecretInputSchema } from "./secret-input.js";

const NextcloudTalkRoomSchema = buildGroupEntrySchema({
  allowFrom: z.array(z.string()).optional(),
}).omit({ toolsBySender: true });

const NextcloudTalkNetworkSchema = z
  .object({
    /** Dangerous opt-in for self-hosted Nextcloud Talk on trusted private/internal hosts. */
    dangerouslyAllowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .optional();

const NextcloudTalkCommonAccountShape = buildCommonChannelAccountShape({
  useDefaults: true,
  omit: [
    "capabilities",
    "allowFrom",
    "defaultTo",
    "groupAllowFrom",
    "mentionPatterns",
    "heartbeatVisibility",
    "healthMonitor",
    "replyToMode",
  ],
});

const NextcloudTalkAccountSchemaBase = z
  .object({
    name: NextcloudTalkCommonAccountShape.name,
    enabled: NextcloudTalkCommonAccountShape.enabled,
    configWrites: NextcloudTalkCommonAccountShape.configWrites,
    markdown: NextcloudTalkCommonAccountShape.markdown,
    baseUrl: z.string().optional(),
    botSecret: buildSecretInputSchema().optional(),
    botSecretFile: z.string().optional(),
    apiUser: z.string().optional(),
    apiPassword: buildSecretInputSchema().optional(),
    apiPasswordFile: z.string().optional(),
    dmPolicy: NextcloudTalkCommonAccountShape.dmPolicy,
    webhookPort: z.number().int().positive().optional(),
    webhookHost: z.string().optional(),
    webhookPath: z.string().optional(),
    webhookPublicUrl: z.string().optional(),
    allowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: NextcloudTalkCommonAccountShape.groupPolicy,
    rooms: z.record(z.string(), NextcloudTalkRoomSchema.optional()).optional(),
    /** Network policy overrides for self-hosted Nextcloud Talk on trusted private/internal hosts. */
    network: NextcloudTalkNetworkSchema,
    historyLimit: NextcloudTalkCommonAccountShape.historyLimit,
    dmHistoryLimit: NextcloudTalkCommonAccountShape.dmHistoryLimit,
    contextVisibility: NextcloudTalkCommonAccountShape.contextVisibility,
    dms: NextcloudTalkCommonAccountShape.dms,
    textChunkLimit: NextcloudTalkCommonAccountShape.textChunkLimit,
    streaming: NextcloudTalkCommonAccountShape.streaming,
    responsePrefix: NextcloudTalkCommonAccountShape.responsePrefix,
    mediaMaxMb: NextcloudTalkCommonAccountShape.mediaMaxMb,
  })
  .strict();

export const NextcloudTalkConfigSchema = buildMultiAccountChannelSchema(
  NextcloudTalkAccountSchemaBase,
  {
    optionalAccount: true,
    refine: (value, ctx) => {
      requireChannelOpenAllowFrom({
        channel: "nextcloud-talk",
        policy: value.dmPolicy,
        allowFrom: value.allowFrom,
        ctx,
        requireOpenAllowFrom,
      });
    },
  },
);
