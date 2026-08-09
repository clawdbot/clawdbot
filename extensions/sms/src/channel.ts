// Sms plugin module implements channel behavior.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import {
  createHybridChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  type ChannelOutboundSessionRouteParams,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  createAccountStatusSink,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import { createConditionalWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import {
  defineChannelSetupContract,
  type ChannelSetupInput,
} from "openclaw/plugin-sdk/channel-setup";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { isRecord, normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import {
  inspectSmsAccount,
  isSmsAccountConfigured,
  listSmsAccountIds,
  resolveDefaultSmsAccountId,
  resolveSmsAccount,
} from "./accounts.js";
import { SmsChannelConfigSchema } from "./config-schema.js";
import { listRecentSmsDeliveryRecords } from "./delivery-observations.js";
import { collectSmsStartupWarnings, startSmsGatewayAccount } from "./gateway.js";
import type { SmsChannelRuntime } from "./inbound.js";
import {
  looksLikeSmsPhoneNumber,
  normalizeSmsAllowFrom,
  normalizeSmsPhoneNumber,
} from "./phone.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import {
  createSmsMessageReceipt,
  prepareSmsMediaAttempt,
  sendPreparedSmsMediaAttempt,
  sendSmsTextChunks,
  toSmsPlainText,
  type PreparedSmsMediaAttempt,
} from "./send.js";
import { formatSmsProbeLines, probeSmsAccount, type SmsProbe } from "./status.js";
import type { ResolvedSmsAccount } from "./types.js";

const CHANNEL_ID = "sms";

type SmsSetupInput = ChannelSetupInput & {
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
  messagingServiceSid?: string;
  webhookPath?: string;
  publicWebhookUrl?: string;
  dmPolicy?: string;
};

const smsConfigAdapter = createHybridChannelConfigAdapter<ResolvedSmsAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds: listSmsAccountIds,
  resolveAccount: resolveSmsAccount,
  defaultAccountId: resolveDefaultSmsAccountId,
  clearBaseFields: [
    "accountSid",
    "authToken",
    "fromNumber",
    "messagingServiceSid",
    "defaultTo",
    "webhookPath",
    "publicWebhookUrl",
    "dangerouslyDisableSignatureValidation",
    "dmPolicy",
    "allowFrom",
    "textChunkLimit",
  ],
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) =>
    normalizeStringEntries(allowFrom.map((entry) => normalizeSmsAllowFrom(String(entry)))),
  resolveDefaultTo: (account) => account.defaultTo,
});

const resolveSmsDmPolicy = createScopedDmSecurityResolver<ResolvedSmsAccount>({
  channelKey: CHANNEL_ID,
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowFrom,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "pairing",
  approveHint: "openclaw pairing approve sms <code>",
  normalizeEntry: normalizeSmsAllowFrom,
});

const collectSmsSecurityWarnings = createConditionalWarningCollector<ResolvedSmsAccount>(
  (account) =>
    account.dangerouslyDisableSignatureValidation &&
    "- SMS: Twilio signature validation is disabled. Only use this for local testing.",
  (account) =>
    account.dmPolicy === "open" &&
    account.allowFrom.includes("*") &&
    '- SMS: dmPolicy="open" allows any phone number to message the bot.',
);

function smsSetupPatch(input: SmsSetupInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of [
    "accountSid",
    "authToken",
    "fromNumber",
    "messagingServiceSid",
    "defaultTo",
    "webhookPath",
    "publicWebhookUrl",
    "dmPolicy",
    "allowFrom",
  ] as const) {
    if (input[key] !== undefined) {
      patch[key] = input[key];
    }
  }
  return patch;
}

function applySmsAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: SmsSetupInput;
}): OpenClawConfig {
  const patch = smsSetupPatch(params.input);
  const channels = { ...params.cfg.channels };
  const current = { ...(channels[CHANNEL_ID] as Record<string, unknown> | undefined) };
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    channels[CHANNEL_ID] = { ...current, ...patch };
    return { ...params.cfg, channels };
  }
  const accounts = { ...(current.accounts as Record<string, unknown> | undefined) };
  accounts[params.accountId] = {
    ...(accounts[params.accountId] as Record<string, unknown> | undefined),
    ...patch,
  };
  channels[CHANNEL_ID] = { ...current, accounts };
  return { ...params.cfg, channels };
}

const smsSetupContract = defineChannelSetupContract({
  fields: {
    accountSid: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--account-sid <sid>", description: "Twilio account SID" },
    },
    authToken: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--auth-token <token>", description: "Twilio auth token" },
    },
    fromNumber: {
      kind: "string",
      cli: { flags: "--from-number <e164>", description: "Twilio sender phone number" },
    },
    messagingServiceSid: {
      kind: "string",
      cli: { flags: "--messaging-service-sid <sid>", description: "Twilio Messaging Service SID" },
    },
    defaultTo: {
      kind: "string",
      cli: { flags: "--default-to <e164>", description: "Default SMS recipient" },
    },
    webhookPath: {
      kind: "string",
      cli: { flags: "--webhook-path <path>", description: "SMS webhook path" },
    },
    publicWebhookUrl: {
      kind: "string",
      cli: { flags: "--public-webhook-url <url>", description: "Public SMS webhook URL" },
    },
    dmPolicy: {
      kind: "choice",
      choices: ["pairing", "allowlist", "open", "disabled"],
      cli: { flags: "--dm-policy <policy>", description: "SMS DM policy" },
    },
    allowFrom: {
      kind: "string-list",
      cli: { flags: "--allow-from <numbers>", description: "Allowed SMS senders" },
    },
  },
  adapter: { applyAccountConfig: applySmsAccountConfig },
});

function createSmsReceipt(params: {
  results: Array<{ sid: string; to: string; from?: string; status?: string }>;
  kind: "text" | "media";
}) {
  const first = params.results[0];
  if (!first) {
    throw new Error("SMS send did not return a Twilio Message SID.");
  }
  const receipt = createSmsMessageReceipt(params);
  return {
    channel: CHANNEL_ID,
    messageId: first.sid,
    chatId: first.to,
    receipt,
  };
}

function resolveSmsTextChunkLimit(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  fallbackLimit?: number;
}): number {
  return (
    resolveSmsAccount(params.cfg, params.accountId).textChunkLimit || params.fallbackLimit || 1500
  );
}

async function sendSmsText(ctx: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
  onPlatformSendDispatch?: Parameters<typeof sendSmsTextChunks>[0]["onPlatformSendDispatch"];
  onDeliveryResult?: Parameters<typeof sendSmsTextChunks>[0]["onDeliveryResult"];
}) {
  const account = resolveSmsAccount(ctx.cfg, ctx.accountId);
  const to = normalizeSmsPhoneNumber(ctx.to) || account.defaultTo;
  if (!looksLikeSmsPhoneNumber(to)) {
    throw new Error(`Invalid SMS target: ${ctx.to}`);
  }
  const results = await sendSmsTextChunks({
    account,
    to,
    text: ctx.text,
    onPlatformSendDispatch: ctx.onPlatformSendDispatch,
    onDeliveryResult: ctx.onDeliveryResult,
  });
  return createSmsReceipt({ results, kind: "text" });
}

type SmsAttachmentContext = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
  mediaUrl: string;
  mediaAccess?: Parameters<typeof prepareSmsMediaAttempt>[0]["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  onPlatformSendDispatch?: Parameters<
    typeof sendPreparedSmsMediaAttempt
  >[0]["onPlatformSendDispatch"];
  onDeliveryResult?: Parameters<typeof sendPreparedSmsMediaAttempt>[0]["onDeliveryResult"];
};

type PreparedSmsAttachmentAttempt = {
  account: ResolvedSmsAccount;
  to: string;
  attempt: PreparedSmsMediaAttempt;
  platformDispatchStarted: boolean;
};

// Core passes the same context object through lifecycle preparation and send.
// Object identity keeps hosted bearer URLs scoped to exactly one MMS attempt.
const preparedSmsAttachmentAttempts = new WeakMap<object, Promise<PreparedSmsAttachmentAttempt>>();

function resolveSmsAttachmentAttemptToken(
  attemptToken: unknown,
): Pick<PreparedSmsAttachmentAttempt, "attempt" | "platformDispatchStarted"> | undefined {
  if (
    !isRecord(attemptToken) ||
    typeof attemptToken.platformDispatchStarted !== "boolean" ||
    !isRecord(attemptToken.attempt) ||
    typeof attemptToken.attempt.cleanupHostedMedia !== "function"
  ) {
    return undefined;
  }
  return attemptToken as Pick<PreparedSmsAttachmentAttempt, "attempt" | "platformDispatchStarted">;
}

async function prepareSmsAttachmentAttempt(
  ctx: SmsAttachmentContext,
): Promise<PreparedSmsAttachmentAttempt> {
  const account = resolveSmsAccount(ctx.cfg, ctx.accountId);
  const to = normalizeSmsPhoneNumber(ctx.to) || account.defaultTo;
  if (!looksLikeSmsPhoneNumber(to)) {
    throw new Error(`Invalid SMS target: ${ctx.to}`);
  }
  const attempt = await prepareSmsMediaAttempt({
    account,
    text: ctx.text,
    mediaUrl: ctx.mediaUrl,
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
  });
  return { account, to, attempt, platformDispatchStarted: false };
}

function getOrPrepareSmsAttachmentAttempt(
  ctx: SmsAttachmentContext,
): Promise<PreparedSmsAttachmentAttempt> {
  const existing = preparedSmsAttachmentAttempts.get(ctx);
  if (existing) {
    return existing;
  }
  const created = prepareSmsAttachmentAttempt(ctx);
  preparedSmsAttachmentAttempts.set(ctx, created);
  return created;
}

async function sendPreparedSmsAttachment(ctx: SmsAttachmentContext) {
  const preparation = preparedSmsAttachmentAttempts.get(ctx);
  preparedSmsAttachmentAttempts.delete(ctx);
  if (!preparation) {
    throw new Error("SMS message lifecycle did not prepare the MMS attachment.");
  }
  const prepared = await preparation;
  const results = await sendPreparedSmsMediaAttempt({
    ...prepared,
    onPlatformSendDispatch: async () => {
      await ctx.onPlatformSendDispatch?.();
      prepared.platformDispatchStarted = true;
    },
    onDeliveryResult: ctx.onDeliveryResult,
  });
  return createSmsReceipt({ results, kind: "media" });
}

const smsMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      messageSendingHooks: true,
    },
  },
  send: {
    lifecycle: {
      beforeSendAttempt: async (ctx) => {
        if (ctx.kind !== "media") {
          return undefined;
        }
        return await getOrPrepareSmsAttachmentAttempt(ctx);
      },
      afterSendFailure: async (ctx) => {
        if (ctx.kind !== "media") {
          return;
        }
        const attemptToken = resolveSmsAttachmentAttemptToken(ctx.attemptToken);
        // Core can fail after staging but before the adapter starts. Discard only
        // while the attempt still proves Twilio's HTTP boundary was never crossed.
        if (!attemptToken || attemptToken.platformDispatchStarted) {
          return;
        }
        await attemptToken.attempt.cleanupHostedMedia();
      },
    },
    text: async (ctx) => await sendSmsText(ctx),
    media: async (ctx) => await sendPreparedSmsAttachment(ctx),
  },
});

function resolveSmsOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const to = normalizeSmsPhoneNumber(params.resolvedTarget?.to ?? params.target);
  if (!looksLikeSmsPhoneNumber(to)) {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: CHANNEL_ID,
    accountId: params.accountId,
    recipientSessionExact: true,
    peer: { kind: "direct", id: to },
    chatType: "direct",
    from: `sms:${to}`,
    to: `sms:${to}`,
  });
}

export const smsPlugin: ChannelPlugin<ResolvedSmsAccount, SmsProbe> = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "SMS",
      selectionLabel: "SMS (Twilio)",
      detailLabel: "Twilio SMS/MMS",
      docsPath: "/channels/sms",
      docsLabel: "sms",
      blurb: "Twilio-backed SMS/MMS with inbound webhooks and outbound replies.",
      order: 88,
    },
    capabilities: {
      chatTypes: ["direct"],
      media: true,
      threads: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: false,
      effects: false,
      blockStreaming: false,
    },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
    configSchema: SmsChannelConfigSchema,
    setupContract: smsSetupContract,
    config: {
      ...smsConfigAdapter,
      inspectAccount: inspectSmsAccount,
      isConfigured: isSmsAccountConfigured,
      unconfiguredReason: () =>
        "SMS requires accountSid, authToken, and fromNumber or messagingServiceSid.",
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.fromNumber || account.messagingServiceSid || "SMS",
        configured: isSmsAccountConfigured(account),
        enabled: account.enabled,
      }),
    },
    messaging: {
      targetPrefixes: ["twilio-sms"],
      normalizeTarget: (target) => normalizeSmsPhoneNumber(target),
      resolveOutboundSessionRoute: (params) => resolveSmsOutboundSessionRoute(params),
      targetResolver: {
        looksLikeId: looksLikeSmsPhoneNumber,
        hint: "<+15551234567>",
      },
    },
    directory: createEmptyChannelDirectoryAdapter(),
    gateway: {
      startAccount: async (ctx) => {
        if (!ctx.channelRuntime) {
          ctx.log?.warn?.("SMS channel runtime is not available; webhook route not started");
          return;
        }
        const statusSink = createAccountStatusSink({
          accountId: ctx.account.accountId,
          setStatus: ctx.setStatus,
        });
        return await startSmsGatewayAccount({
          cfg: ctx.cfg,
          account: ctx.account,
          channelRuntime: ctx.channelRuntime as unknown as SmsChannelRuntime,
          abortSignal: ctx.abortSignal,
          log: ctx.log,
          statusSink,
        });
      },
    },
    status: createComputedAccountStatusAdapter<ResolvedSmsAccount, SmsProbe>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      resolveAccountSnapshot: ({ account }) => {
        const configured = isSmsAccountConfigured(account);
        return {
          accountId: account.accountId,
          name: account.fromNumber || account.messagingServiceSid || "SMS",
          enabled: account.enabled,
          configured,
          extra: {
            statusState: !account.enabled ? "disabled" : configured ? "configured" : "unconfigured",
          },
        };
      },
      probeAccount: async ({ account, timeoutMs }) => {
        const startedAt = Date.now();
        const deliveryRecords = await listRecentSmsDeliveryRecords(account);
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        return await probeSmsAccount({
          account,
          timeoutMs: Math.max(1, timeoutMs - elapsedMs),
          options: { deliveryRecords },
        });
      },
      formatCapabilitiesProbe: ({ probe }) => formatSmsProbeLines(probe),
      buildCapabilitiesDiagnostics: async ({ account }) => ({
        lines: collectSmsStartupWarnings(account).map((text) => ({ text, tone: "warn" })),
      }),
    }),
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
    agentPrompt: {
      messageToolHints: () => [
        "",
        "### SMS Formatting",
        "SMS text is plain text. MMS attachments are supported; keep captions brief and avoid markdown tables.",
      ],
    },
    message: smsMessageAdapter,
  },
  pairing: {
    text: {
      idLabel: "phoneNumber",
      message: "OpenClaw: your SMS access has been approved.",
      normalizeAllowEntry: normalizeSmsAllowFrom,
      notify: async ({ cfg, id, message, accountId }) => {
        const account = resolveSmsAccount(cfg, accountId);
        await sendSmsTextChunks({
          account,
          to: normalizeSmsPhoneNumber(id),
          text: message,
        });
      },
    },
  },
  security: {
    resolveDmPolicy: resolveSmsDmPolicy,
    collectWarnings: ({ account }) => collectSmsSecurityWarnings(account),
  },
  outbound: {
    deliveryMode: "gateway",
    chunker: chunkTextForOutbound,
    chunkerMode: "text",
    textChunkLimit: 1500,
    resolveEffectiveTextChunkLimit: resolveSmsTextChunkLimit,
    resolveTarget: ({ cfg, to, accountId }) => {
      const explicit = normalizeSmsPhoneNumber(to ?? "");
      if (explicit) {
        return { ok: true, to: explicit };
      }
      if (cfg) {
        const account = resolveSmsAccount(cfg, accountId);
        if (account.defaultTo) {
          return { ok: true, to: account.defaultTo };
        }
      }
      return { ok: false, error: new Error("SMS target must be an E.164 phone number.") };
    },
    sanitizeText: ({ text }) => toSmsPlainText(text),
    sendText: sendSmsText,
  },
});
