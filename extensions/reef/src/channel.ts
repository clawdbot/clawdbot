import {
  dispatchInboundDirectDmWithRuntime,
  recordChannelBotPairLoopAndCheckSuppression,
} from "openclaw/plugin-sdk/channel-inbound";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import {
  buildChannelConfigSchema,
  buildChannelOutboundSessionRoute,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/core";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import {
  ReefChannelConfigSchema,
  autonomyBudget,
  normalizeReefTarget,
  resolveReefConfig,
  type ReefCoreConfig,
} from "./config-schema.js";
import { createConfiguredGuard, ReefMessageFlow } from "./flow.js";
import { ReefFriendManager } from "./friends.js";
import { reefMessageAdapter, reefOutboundAdapter } from "./outbound.js";
import { getActiveReef, getOptionalReefRuntime, getReefRuntime, setActiveReef } from "./runtime.js";
import { reefSetupAdapter, reefSetupWizard } from "./setup.js";
import { loadKeys, openStores, resolveStateDir, ReviewApprovalStore } from "./state.js";
import {
  ReefInboxConnection,
  ReefTransportClient,
  type WebSocketLike,
  abortableSleep,
} from "./transport.js";
import { isReefPairingApprovalToken, openReefTrustStore } from "./trust-store.js";
import type { ReefAccount, ReefIngressMessage } from "./types.js";

function resolveAccount(cfg: unknown): ReefAccount {
  const config = resolveReefConfig(cfg as ReefCoreConfig);
  return {
    accountId: "default",
    enabled: config.enabled,
    configured: Boolean(config.handle && config.email && config.guard),
    config,
  };
}

function listTrustedPeers(config: ReefAccount["config"]): string[] {
  if (!config.handle) {
    return [];
  }
  // Read-only setup, doctor, and audit discovery can load the channel shape
  // without initializing the live plugin runtime.
  const runtime = getOptionalReefRuntime();
  return runtime
    ? openReefTrustStore(runtime, config)
        .list()
        .map((entry) => entry.peer)
    : [];
}

export const reefPlugin: ChannelPlugin<ReefAccount> = {
  id: "reef",
  meta: {
    id: "reef",
    label: "Reef",
    selectionLabel: "Reef",
    detailLabel: "Reef guarded claw channel",
    docsPath: "/channels/reef",
    docsLabel: "reef",
    blurb: "Guarded end-to-end encrypted claw messaging.",
    systemImage: "message.badge",
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    reactions: false,
    threads: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.reef"] },
  configSchema: buildChannelConfigSchema(ReefChannelConfigSchema),
  setup: reefSetupAdapter,
  setupWizard: reefSetupWizard as never,
  config: {
    listAccountIds: () => ["default"],
    defaultAccountId: () => "default",
    resolveAccount,
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => account.configured,
    resolveAllowFrom: ({ cfg }) => {
      const config = resolveReefConfig(cfg as ReefCoreConfig);
      return listTrustedPeers(config);
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map(String).map((entry) => normalizeReefTarget(entry) ?? entry),
    describeAccount: (account) => {
      const friendCount = listTrustedPeers(account.config).length;
      return {
        accountId: "default",
        enabled: account.enabled,
        configured: account.configured,
        extra: {
          handle: account.config.handle,
          relayUrl: account.config.relayUrl,
          friendCount,
        },
      };
    },
  },
  messaging: {
    targetPrefixes: ["reef"],
    normalizeTarget: normalizeReefTarget,
    inferTargetChatType: () => "direct",
    targetResolver: {
      looksLikeId: (value) => normalizeReefTarget(value) !== undefined,
      hint: "<@handle|reef:handle>",
    },
    resolveOutboundSessionRoute: (params) => {
      const peer = normalizeReefTarget(params.target);
      return peer
        ? buildChannelOutboundSessionRoute({
            cfg: params.cfg,
            agentId: params.agentId,
            channel: "reef",
            ...(params.accountId !== undefined ? { accountId: params.accountId } : {}),
            peer: { kind: "direct", id: peer },
            chatType: "direct",
            from: `reef:${peer}`,
            to: `reef:${peer}`,
          })
        : null;
    },
  },
  directory: createEmptyChannelDirectoryAdapter(),
  message: reefMessageAdapter,
  outbound: reefOutboundAdapter,
  pairing: {
    idLabel: "reefHandle",
    normalizeAllowEntry: (entry) =>
      isReefPairingApprovalToken(entry)
        ? entry.trim()
        : (normalizeReefTarget(entry) ?? entry.trim().toLowerCase()),
    resolveApprovalStoreEntry: ({ meta }) => meta?.reefApproval ?? null,
    notifyApproval: async ({ id }) => {
      const active = getActiveReef();
      await active.friends.reconcile();
      await active.flow.send(id, PAIRING_APPROVED_MESSAGE);
    },
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: "pairing",
      allowFrom: listTrustedPeers(account.config),
      policyPath: "Reef local peer trust",
      allowFromPath: "Reef local peer trust",
      approveHint: "openclaw pairing approve reef <code>",
      normalizeEntry: (entry) => normalizeReefTarget(entry) ?? entry,
    }),
  },
  status: {
    defaultRuntime: { accountId: "default", enabled: true, configured: false },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: "default",
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError ?? null,
      extra: { handle: account.config.handle },
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      if (!ctx.account.configured) {
        throw new Error("Reef requires handle, email, and guard config");
      }
      const runtime = getReefRuntime();
      const stateDir = resolveStateDir(ctx.account.config.stateDir);
      const keys = await loadKeys(stateDir);
      const transport = new ReefTransportClient(
        ctx.account.config.relayUrl,
        ctx.account.config.handle!,
        keys,
      );
      const stores = openStores(stateDir, keys);
      const reviews = new ReviewApprovalStore(stateDir);
      const pairing = createChannelPairingController({
        core: runtime,
        channel: "reef",
        accountId: "default",
      });
      const trust = openReefTrustStore(runtime, ctx.account.config);
      const friends = new ReefFriendManager(transport, trust, {
        list: pairing.readAllowFromStore,
        remove: async (peer) => {
          return (await pairing.removeAllowFromStoreEntry(peer)).changed;
        },
      });
      const onIngress = async (message: ReefIngressMessage) => {
        const budget = autonomyBudget(message.autonomy);
        const loop = recordChannelBotPairLoopAndCheckSuppression({
          scopeId: "reef:default",
          conversationId: message.thread ?? message.id,
          senderId: message.peer,
          receiverId: ctx.account.config.handle!,
          config: budget.botLoopProtection,
          defaultEnabled: true,
        });
        if (loop.suppressed) {
          await ownerNotice(
            `Reef auto-reply budget exhausted for @${message.peer}; delivery paused until cooldown.`,
          );
          return;
        }
        await dispatchInboundDirectDmWithRuntime({
          cfg: ctx.cfg,
          runtime,
          channel: "reef",
          channelLabel: "Reef",
          accountId: "default",
          peer: { kind: "direct", id: message.peer },
          senderId: message.peer,
          senderAddress: `reef:${message.peer}`,
          recipientAddress: `reef:${ctx.account.config.handle}`,
          conversationLabel: `@${message.peer}'s agent`,
          rawBody: message.text,
          bodyForAgent: `${message.provenance}\n\n<reef-message>${message.text}</reef-message>`,
          messageId: message.id,
          commandAuthorized: false,
          extraContext: {
            ReefProvenance: message.provenance,
            ReefEnvelopeId: message.id,
            SenderIsBot: true,
          },
          deliver: async (payload) => {
            const text =
              payload && typeof payload === "object" && "text" in payload
                ? typeof (payload as { text?: unknown }).text === "string"
                  ? (payload as { text: string }).text
                  : ""
                : "";
            if (text.trim()) {
              await flow.send(message.peer, text, {
                thread: message.thread ?? message.id,
                replyTo: message.id,
              });
            }
          },
          onRecordError: (error) =>
            ctx.log?.error?.(`reef inbound record failed: ${String(error)}`),
          onDispatchError: (error) =>
            ctx.log?.error?.(`reef inbound dispatch failed: ${String(error)}`),
        });
      };
      const ownerNotice = async (text: string) => {
        const route = runtime.channel.routing.resolveAgentRoute({
          cfg: ctx.cfg,
          channel: "reef",
          accountId: "default",
          peer: { kind: "direct", id: ctx.account.config.handle! },
        });
        runtime.system.enqueueSystemEvent(text, {
          sessionKey: route.sessionKey,
          contextKey: `reef:${ctx.account.config.handle}`,
        });
      };
      const flow: ReefMessageFlow = new ReefMessageFlow({
        config: ctx.account.config,
        trust,
        keys,
        stateDir,
        transport,
        guard: createConfiguredGuard(ctx.account.config),
        audit: stores.audit,
        replay: stores.replay,
        reviews,
        onIngress,
        onOwnerNotice: ownerNotice,
      });
      setActiveReef({ flow, friends, reviews });

      const reconcile = async () => {
        await friends.reconcile();
        await friends.surfacePairingCandidates(async ({ peer, fingerprint, approvalToken }) => {
          await pairing.issueChallenge({
            senderId: peer,
            senderIdLine: `Reef handle: @${peer}\nSafety fingerprint: ${fingerprint}`,
            meta: { reefApproval: approvalToken },
            sendPairingReply: async () => {},
          });
        });
      };
      await reconcile();
      ctx.setStatus({ accountId: "default", running: true, connected: false });
      const socketFactory = (url: string) => new WebSocket(url) as unknown as WebSocketLike;
      const inbox = new ReefInboxConnection(
        transport,
        (entries) => flow.processEntries(entries),
        socketFactory,
        (state) => {
          if (ctx.abortSignal.aborted) {
            return;
          }
          ctx.setStatus(
            state === "connected"
              ? {
                  accountId: "default",
                  running: true,
                  connected: true,
                  lastConnectedAt: Date.now(),
                }
              : { accountId: "default", running: true, connected: false },
          );
        },
      );
      const reconciliationLoop = async () => {
        while (!ctx.abortSignal.aborted) {
          await abortableSleep(30_000, ctx.abortSignal);
          if (!ctx.abortSignal.aborted) {
            await reconcile();
          }
        }
      };
      try {
        await Promise.all([inbox.start(ctx.abortSignal), reconciliationLoop()]);
      } finally {
        ctx.setStatus({ accountId: "default", running: false, connected: false });
      }
    },
  },
};
