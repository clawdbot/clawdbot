// Slack helper module supports config schema behavior.
import {
  buildChannelAllowBotsSchema,
  buildChannelConfigSchema,
  buildChannelExecApprovalsSchema,
  buildChannelReactionShape,
  buildCommonChannelAccountShape,
  buildGroupEntrySchema,
  ChannelBotLoopProtectionSchema,
  ChannelDangerouslyAllowNameMatchingSchema,
  ChannelImplicitMentionsSchema,
  ChannelPreviewStreamingConfigSchema,
  ChannelStreamingProgressSchema,
  GroupPolicySchema,
  ProviderCommandsSchema,
  ReplyToModeSchema,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema, hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { slackChannelConfigUiHints } from "./config-ui-hints.js";

const SecretInputSchema = buildSecretInputSchema();

const SlackStreamingProgressSchema = ChannelStreamingProgressSchema.extend({
  nativeTaskCards: z.boolean().optional(),
}).strict();
const SlackStreamingConfigSchema = ChannelPreviewStreamingConfigSchema.extend({
  nativeTransport: z.boolean().optional(),
  progress: SlackStreamingProgressSchema.optional(),
}).strict();
const SlackCapabilitiesSchema = z.union([
  z.array(z.string()),
  z
    .object({
      interactiveReplies: z.boolean().optional(),
    })
    .strict(),
]);

const SlackDmSchema = z
  .object({
    enabled: z.boolean().optional(),
    groupEnabled: z.boolean().optional(),
    groupChannels: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict();

const SlackPresenceEventsSchema = z
  .object({
    mode: z.enum(["off", "auto", "on"]).optional(),
  })
  .strict();

const SlackChannelSchema = buildGroupEntrySchema(
  {
    ignoreOtherMentions: z.boolean().optional(),
    replyToMode: ReplyToModeSchema.optional(),
    allowBots: buildChannelAllowBotsSchema({ allowMentions: true }),
    botLoopProtection: ChannelBotLoopProtectionSchema.optional(),
    users: z.array(z.union([z.string(), z.number()])).optional(),
    presenceEvents: SlackPresenceEventsSchema.optional(),
  },
  { omit: ["allowFrom"] },
);

const SlackThreadSchema = z
  .object({
    historyScope: z.enum(["thread", "channel"]).optional(),
    inheritParent: z.boolean().optional(),
    initialHistoryLimit: z.number().int().min(0).optional(),
  })
  .strict();

const ReplyToModeByChatTypeSchema = z
  .object({
    direct: ReplyToModeSchema.optional(),
    group: ReplyToModeSchema.optional(),
    channel: ReplyToModeSchema.optional(),
  })
  .strict();

const SlackRelaySchema = z
  .object({
    url: z.string().optional(),
    authToken: SecretInputSchema.optional(),
    gatewayId: z.string().optional(),
  })
  .strict();

const SlackIdentitySchema = z.enum(["bot", "user"]);

const SlackAccountSchema = z
  .object({
    ...buildCommonChannelAccountShape({
      omit: ["groupAllowFrom"],
      capabilities: SlackCapabilitiesSchema.optional(),
      streaming: SlackStreamingConfigSchema.optional(),
    }),
    postAs: SlackIdentitySchema.default("bot"),
    mode: z.enum(["socket", "http", "relay"]).optional(),
    enterpriseOrgInstall: z.boolean().optional(),
    relay: SlackRelaySchema.optional(),
    signingSecret: SecretInputSchema.optional(),
    webhookPath: z.string().optional(),
    execApprovals: buildChannelExecApprovalsSchema(z.union([z.string(), z.number()])),
    commands: ProviderCommandsSchema,
    botToken: SecretInputSchema.optional(),
    appToken: SecretInputSchema.optional(),
    userToken: SecretInputSchema.optional(),
    userTokenReadOnly: z.boolean().optional().default(true),
    allowBots: buildChannelAllowBotsSchema({ allowMentions: true }),
    botLoopProtection: ChannelBotLoopProtectionSchema.optional(),
    dangerouslyAllowNameMatching: ChannelDangerouslyAllowNameMatchingSchema,
    requireMention: z.boolean().optional(),
    implicitMentions: ChannelImplicitMentionsSchema.optional(),
    unfurlLinks: z.boolean().optional(),
    unfurlMedia: z.boolean().optional(),
    ...buildChannelReactionShape({
      notificationModes: ["off", "own", "all", "allowlist"],
      reactionAllowlist: true,
      ackReaction: z.string().optional(),
    }),
    replyToModeByChatType: ReplyToModeByChatTypeSchema.optional(),
    thread: SlackThreadSchema.optional(),
    presenceEvents: SlackPresenceEventsSchema.optional(),
    actions: z
      .object({
        reactions: z.boolean().optional(),
        messages: z.boolean().optional(),
        pins: z.boolean().optional(),
        search: z.boolean().optional(),
        permissions: z.boolean().optional(),
        memberInfo: z.boolean().optional(),
        channelInfo: z.boolean().optional(),
        emojiList: z.boolean().optional(),
      })
      .strict()
      .optional(),
    slashCommand: z
      .object({
        enabled: z.boolean().optional(),
        name: z.string().optional(),
        sessionPrefix: z.string().optional(),
        ephemeral: z.boolean().optional(),
      })
      .strict()
      .optional(),
    dm: SlackDmSchema.optional(),
    channels: z.record(z.string(), SlackChannelSchema.optional()).optional(),
    typingReaction: z.string().optional(),
  })
  .strict();

// Account entries leave postAs unset to inherit the top-level default. DM allowlist
// validation stays at SlackConfigSchema so entries can also inherit top-level allowFrom.
const SlackAccountEntrySchema = SlackAccountSchema.extend({
  postAs: SlackIdentitySchema.optional(),
});

type SlackAccountLike = {
  enabled?: unknown;
  mode?: unknown;
  signingSecret?: unknown;
};

function validateSlackSigningSecretRequirements(
  value: {
    mode?: unknown;
    signingSecret?: unknown;
    accounts?: Record<string, SlackAccountLike | undefined>;
  },
  ctx: z.RefinementCtx,
): void {
  const resolveMode = (mode: unknown) =>
    mode === "http" || mode === "socket" || mode === "relay" ? mode : undefined;
  const baseMode = resolveMode(value.mode) ?? "socket";
  if (baseMode === "http" && !hasConfiguredSecretInput(value.signingSecret)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'channels.slack.mode="http" requires channels.slack.signingSecret',
      path: ["signingSecret"],
    });
  }
  for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
    if (!account || account.enabled === false) {
      continue;
    }
    const accountMode = resolveMode(account.mode) ?? baseMode;
    if (accountMode !== "http") {
      continue;
    }
    const accountSecret = account.signingSecret ?? value.signingSecret;
    if (!hasConfiguredSecretInput(accountSecret)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'channels.slack.accounts.*.mode="http" requires channels.slack.signingSecret or channels.slack.accounts.*.signingSecret',
        path: ["accounts", accountId, "signingSecret"],
      });
    }
  }
}

export const SlackConfigSchema = SlackAccountSchema.safeExtend({
  mode: z.enum(["socket", "http", "relay"]).optional().default("socket"),
  signingSecret: SecretInputSchema.optional(),
  webhookPath: z.string().optional().default("/slack/events"),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  accounts: z.record(z.string(), SlackAccountEntrySchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  const dmPolicy = value.dmPolicy ?? "pairing";
  const allowFrom = value.allowFrom;
  requireOpenAllowFrom({
    policy: dmPolicy,
    allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.slack.dmPolicy="open" requires channels.slack.allowFrom to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: dmPolicy,
    allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.slack.dmPolicy="allowlist" requires channels.slack.allowFrom to contain at least one sender ID',
  });

  const requireRelayConfig = (
    relay: { url?: unknown; authToken?: unknown; gatewayId?: unknown } | undefined,
    path: (string | number)[],
  ) => {
    if (typeof relay?.url !== "string" || !relay.url.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'channels.slack.mode="relay" requires relay.url',
        path: [...path, "url"],
      });
    }
    if (!hasConfiguredSecretInput(relay?.authToken)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'channels.slack.mode="relay" requires relay.authToken',
        path: [...path, "authToken"],
      });
    }
    if (typeof relay?.gatewayId !== "string" || !relay.gatewayId.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'channels.slack.mode="relay" requires relay.gatewayId',
        path: [...path, "gatewayId"],
      });
    }
  };

  const baseMode = value.mode ?? "socket";
  const accountIds = value.accounts ? Object.keys(value.accounts) : [];
  if (!value.accounts) {
    if (baseMode === "relay") {
      requireRelayConfig(value.relay, ["relay"]);
    }
    validateSlackSigningSecretRequirements(value, ctx);
    return;
  }
  for (const accountId of accountIds) {
    const account = value.accounts[accountId];
    if (!account || account.enabled === false) {
      continue;
    }
    const accountMode = account.mode ?? baseMode;
    const effectiveRelay = {
      ...value.relay,
      ...account.relay,
    };
    const effectivePolicy = account.dmPolicy ?? value.dmPolicy ?? "pairing";
    const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
    requireOpenAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.slack.accounts.*.dmPolicy="open" requires channels.slack.accounts.*.allowFrom (or channels.slack.allowFrom) to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.slack.accounts.*.dmPolicy="allowlist" requires channels.slack.accounts.*.allowFrom (or channels.slack.allowFrom) to contain at least one sender ID',
    });
    if (accountMode !== "http") {
      if (accountMode === "relay") {
        requireRelayConfig(effectiveRelay, ["accounts", accountId, "relay"]);
      }
      continue;
    }
  }
  validateSlackSigningSecretRequirements(value, ctx);
});

export const SlackChannelConfigSchema = buildChannelConfigSchema(SlackConfigSchema, {
  uiHints: slackChannelConfigUiHints,
});
