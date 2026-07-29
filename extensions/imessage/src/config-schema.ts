// iMessage helper module supports config schema behavior.
import {
  buildChannelConfigSchema,
  buildChannelReactionShape,
  buildCommonChannelAccountShape,
  buildGroupEntrySchema,
  ChannelDeliveryStreamingConfigSchema,
  ChannelSendReadReceiptsSchema,
  ExecutableTokenSchema,
  isSafeScpRemoteHost,
  isValidInboundPathRootPattern,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";
import { iMessageChannelConfigUiHints } from "./config-ui-hints.js";

const IMessageActionSchema = z
  .object({
    reactions: z.boolean().optional(),
    edit: z.boolean().optional(),
    unsend: z.boolean().optional(),
    reply: z.boolean().optional(),
    sendWithEffect: z.boolean().optional(),
    renameGroup: z.boolean().optional(),
    setGroupIcon: z.boolean().optional(),
    addParticipant: z.boolean().optional(),
    removeParticipant: z.boolean().optional(),
    leaveGroup: z.boolean().optional(),
    sendAttachment: z.boolean().optional(),
    polls: z.boolean().optional(),
  })
  .strict()
  .optional();

const IMessageAccountSchemaBase = z
  .object({
    ...buildCommonChannelAccountShape({
      useDefaults: true,
      omit: ["mentionPatterns", "replyToMode"],
      streaming: ChannelDeliveryStreamingConfigSchema.optional(),
      mediaMaxMb: z.number().int().positive().optional(),
    }),
    cliPath: ExecutableTokenSchema.optional(),
    dbPath: z.string().optional(),
    remoteHost: z
      .string()
      .refine(isSafeScpRemoteHost, "expected SSH host or user@host (no spaces/options)")
      .optional(),
    actions: IMessageActionSchema,
    service: z.union([z.literal("imessage"), z.literal("sms"), z.literal("auto")]).optional(),
    sendTransport: z.enum(["auto", "bridge", "applescript"]).optional(),
    region: z.string().optional(),
    includeAttachments: z.boolean().optional(),
    attachmentRoots: z
      .array(z.string().refine(isValidInboundPathRootPattern, "expected absolute path root"))
      .optional(),
    remoteAttachmentRoots: z
      .array(z.string().refine(isValidInboundPathRootPattern, "expected absolute path root"))
      .optional(),
    probeTimeoutMs: z.number().int().positive().optional(),
    sendReadReceipts: ChannelSendReadReceiptsSchema,
    ...buildChannelReactionShape({ notificationModes: ["off", "own", "all"] }),
    catchup: z
      .object({
        enabled: z.boolean().optional(),
        maxAgeMinutes: z.number().int().min(1).max(720).optional(),
        perRunLimit: z.number().int().min(1).max(500).optional(),
        firstRunLookbackMinutes: z.number().int().min(1).max(720).optional(),
        maxFailureRetries: z.number().int().min(1).max(1000).optional(),
      })
      .strict()
      .optional(),
    groups: z
      .record(
        z.string(),
        buildGroupEntrySchema(undefined, {
          omit: ["skills", "enabled", "allowFrom"],
        }).optional(),
      )
      .optional(),
  })
  .strict();

export const IMessageConfigSchema = IMessageAccountSchemaBase.extend({
  // Account-level schemas skip allowFrom validation because accounts inherit
  // allowFrom from the parent channel config at runtime.
  accounts: z.record(z.string(), IMessageAccountSchemaBase.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.imessage.dmPolicy="open" requires channels.imessage.allowFrom to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.imessage.dmPolicy="allowlist" requires channels.imessage.allowFrom to contain at least one sender ID',
  });

  if (!value.accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
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
        'channels.imessage.accounts.*.dmPolicy="open" requires channels.imessage.accounts.*.allowFrom (or channels.imessage.allowFrom) to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.imessage.accounts.*.dmPolicy="allowlist" requires channels.imessage.accounts.*.allowFrom (or channels.imessage.allowFrom) to contain at least one sender ID',
    });
  }
});

export const IMessageChannelConfigSchema = buildChannelConfigSchema(IMessageConfigSchema, {
  uiHints: iMessageChannelConfigUiHints,
});
