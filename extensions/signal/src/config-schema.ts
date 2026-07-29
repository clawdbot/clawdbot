// Signal helper module supports config schema behavior.
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveAccountEntry,
} from "openclaw/plugin-sdk/account-resolution";
import {
  buildChannelConfigSchema,
  buildChannelReactionShape,
  buildCommonChannelAccountShape,
  buildGroupEntrySchema,
  ChannelDeliveryStreamingConfigSchema,
  ChannelSendReadReceiptsSchema,
  ExecutableTokenSchema,
  ReplyToModeSchema,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import { signalChannelConfigUiHints } from "./config-ui-hints.js";

const SIGNAL_RETIRED_TRANSPORT_KEYS = [
  "apiMode",
  "configPath",
  "httpUrl",
  "httpHost",
  "httpPort",
  "cliPath",
  "autoStart",
  "startupTimeoutMs",
  "receiveMode",
  "ignoreStories",
] as const;

const SIGNAL_TRANSPORT_URL_PATTERN = /^[Hh][Tt][Tt][Pp][Ss]?:\/\/(?![^/?#]*@)/;
const SignalTransportUrlSchema = z
  .string()
  .url()
  // Keep this as a regex so the HTTP-only and credential-free contract survives JSON Schema
  // generation. Runtime URL parsing remains the final canonicalization boundary.
  .regex(
    SIGNAL_TRANSPORT_URL_PATTERN,
    "Expected http:// or https:// URL without embedded credentials",
  );

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectSignalConfigForUpdateValidation(value: unknown): unknown {
  if (process.env.OPENCLAW_UPDATE_IN_PROGRESS !== "1" || !isRecord(value)) {
    return value;
  }
  const next = { ...value };
  for (const key of SIGNAL_RETIRED_TRANSPORT_KEYS) {
    delete next[key];
  }
  if (isRecord(value.accounts)) {
    next.accounts = Object.fromEntries(
      Object.entries(value.accounts).map(([accountId, account]) => {
        if (!isRecord(account)) {
          return [accountId, account];
        }
        const nextAccount = { ...account };
        for (const key of SIGNAL_RETIRED_TRANSPORT_KEYS) {
          delete nextAccount[key];
        }
        return [accountId, nextAccount];
      }),
    );
  }
  return next;
}

const SignalTransportSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("managed-native"),
      configPath: z.string().optional(),
      url: SignalTransportUrlSchema.optional(),
      httpHost: z.string().optional(),
      httpPort: z.number().int().min(1).max(65_535).optional(),
      cliPath: ExecutableTokenSchema.optional(),
      startupTimeoutMs: z.number().int().min(1000).max(120000).optional(),
      receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
      ignoreStories: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("external-native"),
      url: SignalTransportUrlSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("container"),
      url: SignalTransportUrlSchema,
    })
    .strict(),
]);

const DirectGroupReplyToModeByChatTypeSchema = z
  .object({
    direct: ReplyToModeSchema.optional(),
    group: ReplyToModeSchema.optional(),
  })
  .strict();

const SignalGroupEntrySchema = buildGroupEntrySchema(
  {
    ingest: z.boolean().optional(),
  },
  { omit: ["skills", "enabled", "allowFrom", "systemPrompt"] },
);

const SignalGroupsSchema = z.record(z.string(), SignalGroupEntrySchema.optional()).optional();

const SignalAccountSchemaBase = z
  .object({
    ...buildCommonChannelAccountShape({
      useDefaults: true,
      omit: ["mentionPatterns"],
      streaming: ChannelDeliveryStreamingConfigSchema.optional(),
      mediaMaxMb: z.number().int().positive().optional(),
    }),
    account: z.string().optional(),
    accountUuid: z.string().optional(),
    transport: SignalTransportSchema.optional(),
    ignoreAttachments: z.boolean().optional(),
    sendReadReceipts: ChannelSendReadReceiptsSchema,
    aliases: z.record(z.string(), z.string()).optional(),
    groups: SignalGroupsSchema,
    replyToModeByChatType: DirectGroupReplyToModeByChatTypeSchema.optional(),
    ...buildChannelReactionShape({
      notificationModes: ["off", "own", "all", "allowlist"],
      reactionAllowlist: true,
      reactionLevels: ["off", "ack", "minimal", "extensive"],
    }),
    actions: z
      .object({
        reactions: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const SignalConfigSchemaBase = SignalAccountSchemaBase.extend({
  // Account-level schemas skip allowFrom validation because accounts inherit
  // allowFrom from the parent channel config at runtime.
  accounts: z.record(z.string(), SignalAccountSchemaBase.optional()).optional(),
  defaultAccount: z.string().optional(),
});
type SignalConfigValidationValue = z.infer<typeof SignalConfigSchemaBase>;

function validateSignalConfigAllowFrom(value: SignalConfigValidationValue, ctx: z.RefinementCtx) {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.signal.dmPolicy="open" requires channels.signal.allowFrom to include "*"',
  });
  requireAllowlistAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.signal.dmPolicy="allowlist" requires channels.signal.allowFrom to contain at least one sender ID',
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
        'channels.signal.accounts.*.dmPolicy="open" requires channels.signal.accounts.*.allowFrom (or channels.signal.allowFrom) to include "*"',
    });
    requireAllowlistAllowFrom({
      policy: effectivePolicy,
      allowFrom: effectiveAllowFrom,
      ctx,
      path: ["accounts", accountId, "allowFrom"],
      message:
        'channels.signal.accounts.*.dmPolicy="allowlist" requires channels.signal.accounts.*.allowFrom (or channels.signal.allowFrom) to contain at least one sender ID',
    });
  }
}

function validateSignalContainerAccounts(value: SignalConfigValidationValue, ctx: z.RefinementCtx) {
  const defaultAccount = resolveAccountEntry(value.accounts, DEFAULT_ACCOUNT_ID);
  const effectiveDefaultAccount =
    defaultAccount?.account === undefined ? value.account : defaultAccount.account;
  const channelEnabled = value.enabled !== false;
  const defaultEnabled = defaultAccount?.enabled !== false;
  if (
    value.transport?.kind === "container" &&
    channelEnabled &&
    defaultEnabled &&
    !normalizeOptionalString(effectiveDefaultAccount)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "channels.signal container transport requires an account number on the channel or default account",
      path: ["account"],
    });
  }

  for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
    if (!account || !channelEnabled || account.enabled === false) {
      continue;
    }
    const isDefaultAccount = normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID;
    const effectiveTransport =
      isDefaultAccount && value.transport ? value.transport : account.transport;
    if (effectiveTransport?.kind !== "container" || (isDefaultAccount && value.transport)) {
      continue;
    }
    const effectiveAccount = account.account === undefined ? value.account : account.account;
    if (!normalizeOptionalString(effectiveAccount)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "channels.signal account container transport requires an account number on the account or channel",
        path: ["accounts", accountId, "account"],
      });
    }
  }
}

const CanonicalSignalConfigSchema = SignalConfigSchemaBase.superRefine((value, ctx) => {
  validateSignalConfigAllowFrom(value, ctx);
  validateSignalContainerAccounts(value, ctx);
});

// During updater-owned migration, validate a projected canonical shape while doctor repairs the
// untouched source config. Normal runtime validation remains strict and reads only current keys.
export const SignalConfigSchema = z.preprocess(
  projectSignalConfigForUpdateValidation,
  CanonicalSignalConfigSchema,
);

export const SignalChannelConfigSchema = buildChannelConfigSchema(SignalConfigSchema, {
  uiHints: signalChannelConfigUiHints,
});
