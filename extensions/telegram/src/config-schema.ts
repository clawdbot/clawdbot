// Telegram helper module supports config schema behavior.
import {
  buildChannelConfigSchema,
  buildChannelExecApprovalsSchema,
  buildChannelReactionShape,
  buildCommonChannelAccountShape,
  buildGroupEntrySchema,
  ChannelPreviewStreamingConfigSchema,
  ChannelStreamingPreviewSchema,
  DmPolicySchema,
  GroupPolicySchema,
  ProviderCommandsSchema,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
  ToolPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import {
  buildSecretInputSchema,
  hasConfiguredSecretInput,
  registerSensitiveConfigSchema,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import {
  normalizeTelegramCommandDescription,
  normalizeTelegramCommandName,
  resolveTelegramCustomCommands,
} from "./command-config.js";
import { telegramChannelConfigUiHints } from "./config-ui-hints.js";

const SecretInputSchema = buildSecretInputSchema();
const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

type TelegramAccountLike = {
  enabled?: unknown;
  webhookUrl?: unknown;
  webhookSecret?: unknown;
};

function validateTelegramWebhookSecretRequirements(
  value: {
    webhookUrl?: unknown;
    webhookSecret?: unknown;
    accounts?: Record<string, TelegramAccountLike | undefined>;
  },
  ctx: z.RefinementCtx,
): void {
  const baseWebhookUrl = normalizeOptionalString(value.webhookUrl) ?? "";
  const hasBaseWebhookSecret = hasConfiguredSecretInput(value.webhookSecret);
  if (baseWebhookUrl && !hasBaseWebhookSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "channels.telegram.webhookUrl requires channels.telegram.webhookSecret",
      path: ["webhookSecret"],
    });
  }
  for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
    if (!account || account.enabled === false) {
      continue;
    }
    const accountWebhookUrl = normalizeOptionalString(account.webhookUrl) ?? "";
    if (!accountWebhookUrl) {
      continue;
    }
    if (!hasConfiguredSecretInput(account.webhookSecret) && !hasBaseWebhookSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "channels.telegram.accounts.*.webhookUrl requires channels.telegram.webhookSecret or channels.telegram.accounts.*.webhookSecret",
        path: ["accounts", accountId, "webhookSecret"],
      });
    }
  }
}

const TelegramInlineButtonsScopeSchema = z.enum(["off", "dm", "group", "all", "allowlist"]);
const TelegramCapabilitiesSchema = z.union([
  z.array(z.string()),
  z
    .object({
      inlineButtons: TelegramInlineButtonsScopeSchema.optional(),
    })
    .strict(),
]);
const TelegramPreviewStreamingConfigSchema = ChannelPreviewStreamingConfigSchema.extend({
  preview: ChannelStreamingPreviewSchema.optional(),
}).strict();
const TelegramErrorPolicySchema = z.enum(["always", "once", "silent"]).optional();
const TelegramTopicSchema = z
  .object({
    requireMention: z.boolean().optional(),
    ingest: z.boolean().optional(),
    disableAudioPreflight: z.boolean().optional(),
    groupPolicy: GroupPolicySchema.optional(),
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
    agentId: z.string().optional(),
    errorPolicy: TelegramErrorPolicySchema,
  })
  .strict();

const TelegramGroupSchema = buildGroupEntrySchema({
  ingest: z.boolean().optional(),
  disableAudioPreflight: z.boolean().optional(),
  groupPolicy: GroupPolicySchema.optional(),
  topics: z.record(z.string(), TelegramTopicSchema.optional()).optional(),
  errorPolicy: TelegramErrorPolicySchema,
});

const AutoTopicLabelSchema = z
  .union([
    z.boolean(),
    z
      .object({
        enabled: z.boolean().optional(),
        prompt: z.string().optional(),
      })
      .strict(),
  ])
  .optional();

const TelegramDirectSchema = z
  .object({
    dmPolicy: DmPolicySchema.optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
    topics: z.record(z.string(), TelegramTopicSchema.optional()).optional(),
    errorPolicy: TelegramErrorPolicySchema,
    requireTopic: z.boolean().optional(),
    autoTopicLabel: AutoTopicLabelSchema,
  })
  .strict();

const TelegramCustomCommandSchema = z
  .object({
    command: z.string().overwrite(normalizeTelegramCommandName),
    description: z.string().overwrite(normalizeTelegramCommandDescription),
  })
  .strict();

const validateTelegramCustomCommands = (
  value: { customCommands?: Array<{ command?: string; description?: string }> },
  ctx: z.RefinementCtx,
) => {
  if (!value.customCommands || value.customCommands.length === 0) {
    return;
  }
  const { issues } = resolveTelegramCustomCommands({
    commands: value.customCommands,
    checkReserved: false,
    checkDuplicates: false,
  });
  for (const issue of issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["customCommands", issue.index, issue.field],
      message: issue.message,
    });
  }
};

const TelegramAccountSchemaBase = z
  .object({
    ...buildCommonChannelAccountShape({
      useDefaults: true,
      capabilities: TelegramCapabilitiesSchema.optional(),
      defaultTo: z.union([z.string(), z.number()]).optional(),
      streaming: TelegramPreviewStreamingConfigSchema.optional(),
    }),
    execApprovals: buildChannelExecApprovalsSchema(z.union([z.string(), z.number()])),
    commands: ProviderCommandsSchema,
    customCommands: z.array(TelegramCustomCommandSchema).optional(),
    botToken: registerSensitiveConfigSchema(SecretInputSchema.optional()),
    tokenFile: z.string().optional(),
    groups: z.record(z.string(), TelegramGroupSchema.optional()).optional(),
    direct: z.record(z.string(), TelegramDirectSchema.optional()).optional(),
    richMessages: z.boolean().optional(),
    network: z
      .object({
        autoSelectFamily: z.boolean().optional(),
        dnsResultOrder: z.enum(["ipv4first", "verbatim"]).optional(),
        dangerouslyAllowPrivateNetwork: z
          .boolean()
          .optional()
          .describe(
            "Dangerous opt-in for trusted Telegram fake-IP or transparent-proxy environments where api.telegram.org resolves to private/internal/special-use addresses during media downloads.",
          ),
      })
      .strict()
      .optional(),
    proxy: z.string().optional(),
    webhookUrl: z
      .string()
      .optional()
      .describe(
        "Public HTTPS webhook URL registered with Telegram for inbound updates. This must be internet-reachable and requires channels.telegram.webhookSecret.",
      ),
    webhookSecret: registerSensitiveConfigSchema(
      SecretInputSchema.optional().describe(
        "Secret token sent to Telegram during webhook registration and verified on inbound webhook requests. Telegram returns this value for verification; this is not the gateway auth token and not the bot token.",
      ),
    ),
    webhookPath: z
      .string()
      .optional()
      .describe(
        "Local webhook route path served by the gateway listener. Defaults to /telegram-webhook.",
      ),
    webhookHost: z
      .string()
      .optional()
      .describe(
        "Local bind host for the webhook listener. Defaults to 127.0.0.1; keep loopback unless you intentionally expose direct ingress.",
      ),
    webhookPort: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Local bind port for the webhook listener. Defaults to 8787; set to 0 to let the OS assign an ephemeral port.",
      ),
    webhookCertPath: z
      .string()
      .optional()
      .describe(
        "Path to the self-signed certificate (PEM) to upload to Telegram during webhook registration. Required for self-signed certs (direct IP or no domain).",
      ),
    actions: z
      .object({
        reactions: z.boolean().optional(),
        sendMessage: z.boolean().optional(),
        poll: z.boolean().optional(),
        deleteMessage: z.boolean().optional(),
        editMessage: z.boolean().optional(),
        sticker: z.boolean().optional(),
        createForumTopic: z.boolean().optional(),
        editForumTopic: z.boolean().optional(),
      })
      .strict()
      .optional(),
    threadBindings: z
      .object({
        enabled: z.boolean().optional(),
        idleHours: z.number().nonnegative().optional(),
        maxAgeHours: z.number().nonnegative().optional(),
        spawnSessions: z.boolean().optional(),
        defaultSpawnContext: z.enum(["isolated", "fork"]).optional(),
      })
      .strict()
      .optional(),
    ...buildChannelReactionShape({
      notificationModes: ["off", "own", "all"],
      reactionLevels: ["off", "ack", "minimal", "extensive"],
      ackReaction: z.string().optional(),
    }),
    linkPreview: z.boolean().optional(),
    silentErrorReplies: z.boolean().optional(),
    errorPolicy: TelegramErrorPolicySchema,
    apiRoot: z.string().url().optional(),
    trustedLocalFileRoots: z
      .array(z.string())
      .optional()
      .describe(
        "Trusted local filesystem roots for self-hosted Telegram Bot API absolute file_path values. Only absolute paths under these roots are read directly; all other absolute paths are rejected.",
      ),
    autoTopicLabel: AutoTopicLabelSchema,
  })
  .strict();

const TelegramAccountSchema = TelegramAccountSchemaBase.superRefine((value, ctx) => {
  // Account-level schemas skip allowFrom validation because accounts inherit
  // allowFrom from the parent channel config at runtime (resolveTelegramAccount
  // shallow-merges top-level and account values in src/telegram/accounts.ts).
  // Validation is enforced at the top-level TelegramConfigSchema instead.
  validateTelegramCustomCommands(value, ctx);
});

export const TelegramConfigSchema = TelegramAccountSchemaBase.extend({
  accounts: z.record(z.string(), TelegramAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.telegram.dmPolicy="open" requires channels.telegram.allowFrom to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.telegram.dmPolicy="allowlist" requires channels.telegram.allowFrom to contain at least one sender ID',
  });
  validateTelegramCustomCommands(value, ctx);

  if (value.accounts) {
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
          'channels.telegram.accounts.*.dmPolicy="open" requires channels.telegram.accounts.*.allowFrom (or channels.telegram.allowFrom) to include "*"',
      });
      requireAllowlistAllowFrom({
        policy: effectivePolicy,
        allowFrom: effectiveAllowFrom,
        ctx,
        path: ["accounts", accountId, "allowFrom"],
        message:
          'channels.telegram.accounts.*.dmPolicy="allowlist" requires channels.telegram.accounts.*.allowFrom (or channels.telegram.allowFrom) to contain at least one sender ID',
      });
    }
  }

  if (!value.accounts) {
    validateTelegramWebhookSecretRequirements(value, ctx);
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    if (account.enabled === false) {
      continue;
    }
    const effectiveDmPolicy = account.dmPolicy ?? value.dmPolicy;
    const effectiveAllowFrom = Array.isArray(account.allowFrom)
      ? account.allowFrom
      : value.allowFrom;
    requireOpenAllowFrom({
      policy: effectiveDmPolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.telegram.accounts.*.dmPolicy="open" requires channels.telegram.allowFrom or channels.telegram.accounts.*.allowFrom to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectiveDmPolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.telegram.accounts.*.dmPolicy="allowlist" requires channels.telegram.allowFrom or channels.telegram.accounts.*.allowFrom to contain at least one sender ID',
    });
  }
  validateTelegramWebhookSecretRequirements(value, ctx);
});

export const TelegramChannelConfigSchema = buildChannelConfigSchema(TelegramConfigSchema, {
  uiHints: telegramChannelConfigUiHints,
});
