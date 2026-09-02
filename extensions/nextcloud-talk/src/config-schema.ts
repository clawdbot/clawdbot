// Nextcloud Talk helper module supports config schema behavior.
import {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  ReplyToModeSchema,
  buildChannelConfigSchema,
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

const NextcloudTalkAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    replyToMode: ReplyToModeSchema.optional(),
    markdown: MarkdownConfigSchema,
    baseUrl: z.string().optional(),
    botSecret: buildSecretInputSchema().optional(),
    botSecretFile: z.string().optional(),
    apiUser: z.string().optional(),
    apiPassword: buildSecretInputSchema().optional(),
    apiPasswordFile: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    webhookPort: z.number().int().positive().optional(),
    webhookHost: z.string().optional(),
    webhookPath: z.string().optional(),
    webhookPublicUrl: z.string().optional(),
    allowFrom: z.array(z.string()).optional(),
    mediaAllowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    rooms: z.record(z.string(), NextcloudTalkRoomSchema.optional()).optional(),
    /** Network policy overrides for self-hosted Nextcloud Talk on trusted private/internal hosts. */
    network: NextcloudTalkNetworkSchema,
    ...ReplyRuntimeConfigSchemaShape,
  })
  .strict();

const NextcloudTalkConfigSchema = buildMultiAccountChannelSchema(NextcloudTalkAccountSchemaBase, {
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
});

export const NextcloudTalkChannelConfigSchema = buildChannelConfigSchema(
  NextcloudTalkConfigSchema,
  {
    uiHints: {
      mediaAllowFrom: {
        label: "Nextcloud Talk Inbound Media Allowlist",
        help: 'User IDs whose attachments may be processed after ordinary access and mention checks. Omitted or empty denies all media; use ["*"] for every otherwise-authorized sender.',
      },
      "accounts.*.mediaAllowFrom": {
        label: "Nextcloud Talk Account Inbound Media Allowlist",
        help: 'Per-account attachment allowlist. Omitted or empty denies all media; use ["*"] for every otherwise-authorized sender.',
      },
    },
  },
);
