// Defines Google Chat provider schema fragments.
import { z } from "zod";
import {
  ChannelBotLoopProtectionSchema,
  ChannelDangerouslyAllowNameMatchingSchema,
  buildChannelAllowBotsSchema,
  buildCommonChannelAccountShape,
} from "./zod-schema.channel-messaging-common.js";
import {
  ChannelDeliveryStreamingConfigSchema,
  DmPolicySchema,
  SecretRefSchema,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "./zod-schema.core.js";
import { sensitive } from "./zod-schema.sensitive.js";

const GoogleChatDmSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict();

const GoogleChatGroupSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    botLoopProtection: ChannelBotLoopProtectionSchema.optional(),
    users: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

const GoogleChatAccountSchemaBase = z
  .object({
    ...buildCommonChannelAccountShape({
      groupPolicyDefault: true,
      omit: ["mentionPatterns"],
      streaming: ChannelDeliveryStreamingConfigSchema.optional(),
    }),
    allowBots: buildChannelAllowBotsSchema(),
    botLoopProtection: ChannelBotLoopProtectionSchema.optional(),
    dangerouslyAllowNameMatching: ChannelDangerouslyAllowNameMatchingSchema,
    requireMention: z.boolean().optional(),
    groups: z.record(z.string(), GoogleChatGroupSchema.optional()).optional(),
    serviceAccount: z
      .union([z.string(), z.record(z.string(), z.unknown()), SecretRefSchema])
      .optional()
      .register(sensitive),
    serviceAccountRef: SecretRefSchema.optional().register(sensitive),
    serviceAccountFile: z.string().optional(),
    audienceType: z.enum(["app-url", "project-number"]).optional(),
    audience: z.string().optional(),
    appPrincipal: z.string().optional(),
    webhookPath: z.string().optional(),
    webhookUrl: z.string().optional(),
    botUser: z.string().optional(),
    dm: GoogleChatDmSchema.optional(),
    typingIndicator: z.enum(["none", "message", "reaction"]).optional(),
  })
  .strict();

export const GoogleChatConfigSchema = GoogleChatAccountSchemaBase.extend({
  dmPolicy: DmPolicySchema.optional().default("pairing"),
  accounts: z.record(z.string(), GoogleChatAccountSchemaBase.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.googlechat.dmPolicy="open" requires channels.googlechat.allowFrom to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.googlechat.dmPolicy="allowlist" requires channels.googlechat.allowFrom to contain at least one sender ID',
  });
  for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
    if (!account) {
      continue;
    }
    const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
    const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
    requireOpenAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.googlechat.accounts.*.dmPolicy="open" requires channels.googlechat.accounts.*.allowFrom (or channels.googlechat.allowFrom) to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.googlechat.accounts.*.dmPolicy="allowlist" requires channels.googlechat.accounts.*.allowFrom (or channels.googlechat.allowFrom) to contain at least one sender ID',
    });
  }
});
