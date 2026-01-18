import { chunkText } from "../../auto-reply/chunk.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import {
  listSignalAccountIds,
  type ResolvedSignalAccount,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "../../signal/accounts.js";
import { probeSignal } from "../../signal/probe.js";
import { sendMessageSignal } from "../../signal/send.js";
import { normalizeE164 } from "../../utils.js";
import { getChatChannelMeta } from "../registry.js";
import { SignalConfigSchema } from "../../config/zod-schema.providers-core.js";
import { buildChannelConfigSchema } from "./config-schema.js";
import {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "./config-helpers.js";
import { formatPairingApproveHint } from "./helpers.js";
import { resolveChannelMediaMaxBytes } from "./media-limits.js";
import { looksLikeSignalTargetId, normalizeSignalMessagingTarget } from "./normalize/signal.js";
import { signalOnboardingAdapter } from "./onboarding/signal.js";
import { PAIRING_APPROVED_MESSAGE } from "./pairing-message.js";
import {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "./setup-helpers.js";
import type { ChannelPlugin } from "./types.js";

const meta = getChatChannelMeta("signal");

export const signalPlugin: ChannelPlugin<ResolvedSignalAccount> = {
  id: "signal",
  meta: {
    ...meta,
  },
  onboarding: signalOnboardingAdapter,
  pairing: {
    idLabel: "signalNumber",
    normalizeAllowEntry: (entry) => entry.replace(/^signal:/i, ""),
    notifyApproval: async ({ id }) => {
      await sendMessageSignal(id, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.signal"] },
  configSchema: buildChannelConfigSchema(SignalConfigSchema),
  config: {
    listAccountIds: (cfg) => listSignalAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveSignalAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultSignalAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "signal",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "signal",
        accountId,
        clearBaseFields: ["account", "httpUrl", "httpHost", "httpPort", "cliPath", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveSignalAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => (entry === "*" ? "*" : normalizeE164(entry.replace(/^signal:/i, ""))))
        .filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.signal?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.signal.accounts.${resolvedAccountId}.`
        : "channels.signal.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("signal"),
        normalizeEntry: (raw) => normalizeE164(raw.replace(/^signal:/i, "").trim()),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        `- Signal groups: groupPolicy="open" allows any member to trigger the bot. Set channels.signal.groupPolicy="allowlist" + channels.signal.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  messaging: {
    normalizeTarget: normalizeSignalMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeSignalTargetId,
      hint: "<E.164|group:ID|signal:group:ID|signal:+E.164>",
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "signal",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (
        !input.signalNumber &&
        !input.httpUrl &&
        !input.httpHost &&
        !input.httpPort &&
        !input.cliPath
      ) {
        return "Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "signal",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "signal",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            signal: {
              ...next.channels?.signal,
              enabled: true,
              ...(input.signalNumber ? { account: input.signalNumber } : {}),
              ...(input.cliPath ? { cliPath: input.cliPath } : {}),
              ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
              ...(input.httpHost ? { httpHost: input.httpHost } : {}),
              ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          signal: {
            ...next.channels?.signal,
            enabled: true,
            accounts: {
              ...next.channels?.signal?.accounts,
              [accountId]: {
                ...next.channels?.signal?.accounts?.[accountId],
                enabled: true,
                ...(input.signalNumber ? { account: input.signalNumber } : {}),
                ...(input.cliPath ? { cliPath: input.cliPath } : {}),
                ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
                ...(input.httpHost ? { httpHost: input.httpHost } : {}),
                ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: chunkText,
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, accountId, deps }) => {
      const send = deps?.sendSignal ?? sendMessageSignal;
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg,
        resolveChannelLimitMb: ({ cfg, accountId }) =>
          cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ??
          cfg.channels?.signal?.mediaMaxMb,
        accountId,
      });
      const result = await send(to, text, {
        maxBytes,
        accountId: accountId ?? undefined,
      });
      return { channel: "signal", ...result };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps }) => {
      const send = deps?.sendSignal ?? sendMessageSignal;
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg,
        resolveChannelLimitMb: ({ cfg, accountId }) =>
          cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ??
          cfg.channels?.signal?.mediaMaxMb,
        accountId,
      });
      const result = await send(to, text, {
        mediaUrl,
        maxBytes,
        accountId: accountId ?? undefined,
      });
      return { channel: "signal", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: "signal",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      baseUrl: snapshot.baseUrl ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      const baseUrl = account.baseUrl;
      return await probeSignal(baseUrl, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
      });
      ctx.log?.info(`[${account.accountId}] starting provider (${account.baseUrl})`);
      // Lazy import: the monitor pulls the reply pipeline; avoid ESM init cycles.
      const { monitorSignalProvider } = await import("../../signal/index.js");
      return monitorSignalProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: account.config.mediaMaxMb,
      });
    },
  },
};
