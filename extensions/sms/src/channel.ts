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
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import { createConditionalWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import type { ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import {
  inspectSmsAccount,
  isSmsAccountConfigured,
  listSmsAccountIds,
  resolveDefaultSmsAccountId,
  resolveSmsAccount,
} from "./accounts.js";
import { SmsChannelConfigSchema } from "./config-schema.js";
import { collectSmsStartupWarnings, startSmsGatewayAccount } from "./gateway.js";
import type { SmsChannelRuntime } from "./inbound.js";
import {
  looksLikeSmsPhoneNumber,
  normalizeSmsAllowFrom,
  normalizeSmsPhoneNumber,
} from "./phone.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { sendSmsTextChunks, toSmsPlainText } from "./send.js";
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

function createSmsReceipt(params: {
  results: Array<{ sid: string; to: string; from?: string; status?: string }>;
  kind: "text";
}) {
  const first = params.results[0];
  if (!first) {
    throw new Error("SMS send did not return a Twilio Message SID.");
  }
  return {
    channel: CHANNEL_ID,
    messageId: first.sid,
    chatId: first.to,
    receipt: createMessageReceiptFromOutboundResults({
      results: params.results.map((result) => ({
        channel: CHANNEL_ID,
        messageId: result.sid,
        chatId: result.to,
        toJid: result.to,
        conversationId: result.to,
        meta: {
          ...(result.from ? { from: result.from } : {}),
          ...(result.status ? { status: result.status } : {}),
        },
      })),
      threadId: first.to,
      kind: params.kind,
    }),
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
}) {
  const account = resolveSmsAccount(ctx.cfg, ctx.accountId);
  const to = normalizeSmsPhoneNumber(ctx.to) || account.defaultTo;
  if (!looksLikeSmsPhoneNumber(to)) {
    throw new Error(`Invalid SMS target: ${ctx.to}`);
  }
  const results = await sendSmsTextChunks({ account, to, text: ctx.text });
  return createSmsReceipt({ results, kind: "text" });
}

const smsMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      media: false,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async (ctx) => await sendSmsText(ctx),
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
      detailLabel: "Twilio SMS",
      docsPath: "/channels/sms",
      docsLabel: "sms",
      blurb: "Twilio-backed SMS with inbound webhooks and outbound replies.",
      order: 88,
    },
    capabilities: {
      chatTypes: ["direct"],
      media: false,
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
    setup: {
      applyAccountConfig: ({ cfg, accountId, input }) =>
        applySmsAccountConfig({ cfg, accountId, input: input as SmsSetupInput }),
    },
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
        return await startSmsGatewayAccount({
          cfg: ctx.cfg,
          account: ctx.account,
          channelRuntime: ctx.channelRuntime as unknown as SmsChannelRuntime,
          abortSignal: ctx.abortSignal,
          log: ctx.log,
        });
      },
    },
    status: {
      buildAccountSnapshot: ({ account }) => {
        const configured = isSmsAccountConfigured(account);
        return {
          accountId: account.accountId,
          name: account.fromNumber || account.messagingServiceSid || "SMS",
          enabled: account.enabled,
          configured,
          statusState: !account.enabled ? "disabled" : configured ? "configured" : "unconfigured",
        };
      },
      probeAccount: async ({ account, timeoutMs }) => await probeSmsAccount({ account, timeoutMs }),
      formatCapabilitiesProbe: ({ probe }) => formatSmsProbeLines(probe),
      buildCapabilitiesDiagnostics: async ({ account }) => ({
        lines: collectSmsStartupWarnings(account).map((text) => ({ text, tone: "warn" })),
      }),
    },
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
    agentPrompt: {
      messageToolHints: () => [
        "",
        "### SMS Formatting",
        "SMS is plain text only. Keep replies brief, avoid markdown tables, and split long details into short messages.",
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
