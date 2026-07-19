import {
  dispatchInboundDirectDm,
  recordChannelBotPairLoopAndCheckSuppression,
} from "openclaw/plugin-sdk/channel-inbound";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import {
  buildChannelConfigSchema,
  buildChannelOutboundSessionRoute,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/core";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { runReefChannelLifecycle } from "./channel-lifecycle.js";
import {
  ReefChannelConfigSchema,
  autonomyBudget,
  normalizeReefTarget,
  parseReefRelayUrl,
  resolveReefConfig,
  type ReefCoreConfig,
} from "./config-schema.js";
import { createConfiguredGuard, ReefMessageFlow } from "./flow.js";
import { ReefFriendManager } from "./friends.js";
import { resolveReefInboundDispatchContent } from "./inbound.js";
import { reefMessageAdapter, reefOutboundAdapter } from "./outbound.js";
import {
  createReefOwnerNoticeHandler,
  notifyOverdueReefDeliveries,
  processReefInboxEntriesInOrder,
  ReefReceiptNotifier,
} from "./owner-notice.js";
import { isRephrasedReefResend } from "./rejection-resend.js";
import { getActiveReef, getOptionalReefRuntime, getReefRuntime, setActiveReef } from "./runtime.js";
import { reefSetupAdapter, reefSetupWizard } from "./setup.js";
import { assertReefIdentityBinding, loadKeys, openStores, ReefInboxCursorStore } from "./state.js";
import {
  ReefInboxConnection,
  ReefTransportClient,
  createReefWebSocket,
  isRetryableReefRelayFailure,
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

function listTrustedPeerDirectoryEntries(params: {
  config: ReefAccount["config"];
  query: string | null | undefined;
  limit: number | null | undefined;
}) {
  const query = normalizeReefTarget(params.query ?? "") ?? params.query?.trim().toLowerCase();
  const peers = listTrustedPeers(params.config).filter(
    (peer) => !query || peer === query || peer.includes(query),
  );
  const limit = params.limit == null ? peers.length : Math.max(0, params.limit);
  return peers.slice(0, limit).map((peer) => ({
    kind: "user" as const,
    id: peer,
    name: `@${peer}'s agent`,
    handle: `@${peer}`,
  }));
}

function replyText(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !("text" in payload)) {
    return "";
  }
  return typeof (payload as { text?: unknown }).text === "string"
    ? (payload as { text: string }).text
    : "";
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
  directory: createChannelDirectoryAdapter({
    listPeers: async ({ cfg, query, limit }) =>
      listTrustedPeerDirectoryEntries({
        config: resolveReefConfig(cfg as ReefCoreConfig),
        query,
        limit,
      }),
    listGroups: async () => [],
  }),
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
      const keys = await loadKeys(runtime);
      const identityBinding = {
        handle: ctx.account.config.handle!,
        relayUrl: parseReefRelayUrl(ctx.account.config.relayUrl),
      };
      assertReefIdentityBinding(runtime, identityBinding);
      const transport = new ReefTransportClient(
        ctx.account.config.relayUrl,
        ctx.account.config.handle!,
        keys,
      );
      const stores = openStores(runtime, keys);
      const inboxCursor = new ReefInboxCursorStore(runtime, identityBinding);
      const reviews = stores.reviews;
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
        const dispatchContent = resolveReefInboundDispatchContent(message);
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
          await ownerNotice({
            text: `Reef auto-reply budget exhausted for @${message.peer}; delivery paused until cooldown.`,
            peer: message.peer,
            contextKey: `reef:budget:${message.peer}`,
          });
          return;
        }
        await dispatchInboundDirectDm({
          cfg: ctx.cfg,
          channel: "reef",
          channelLabel: "Reef",
          accountId: "default",
          peer: { kind: "direct", id: message.peer },
          senderId: message.peer,
          senderAddress: `reef:${message.peer}`,
          recipientAddress: `reef:${ctx.account.config.handle}`,
          conversationLabel: `@${message.peer}'s agent`,
          ...dispatchContent,
          messageId: message.id,
          commandAuthorized: false,
          // ReefMessageFlow invokes ingress only after peer trust and guard approval.
          inboundAccessAuthorized: true,
          deliver: async (payload) => {
            const text = replyText(payload);
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
      const ownerNotice = createReefOwnerNoticeHandler({
        runtime,
        cfg: ctx.cfg,
        accountId: "default",
        handle: ctx.account.config.handle!,
      });
      const flow: ReefMessageFlow = new ReefMessageFlow({
        config: ctx.account.config,
        trust,
        keys,
        transport,
        guard: createConfiguredGuard(ctx.account.config),
        audit: stores.audit,
        replay: stores.replay,
        reviews,
        delivered: stores.delivered,
        onIngress,
        onOwnerNotice: async (text) =>
          ownerNotice({
            text,
            contextKey: `reef:${ctx.account.config.handle}`,
          }),
      });
      const receiptNotifier = new ReefReceiptNotifier(
        async (notice) => {
          let resendText = "";
          let dispatchFailure: Error | undefined;
          await dispatchInboundDirectDm({
            cfg: ctx.cfg,
            channel: "reef",
            channelLabel: "Reef",
            accountId: "default",
            peer: { kind: "direct", id: notice.peer },
            senderId: notice.peer,
            senderAddress: `reef:${notice.peer}`,
            recipientAddress: `reef:${ctx.account.config.handle}`,
            conversationLabel: `Reef delivery receipt for @${notice.peer}`,
            rawBody: notice.text,
            bodyForAgent: notice.text,
            messageId: `rejection-${notice.messageId}`,
            commandAuthorized: false,
            extraContext: {
              ReefDeliveryRejected: true,
              ReefEnvelopeId: notice.messageId,
              SenderIsBot: true,
            },
            deliver: async (payload) => {
              if (!notice.allowResend) {
                return;
              }
              const text = replyText(payload);
              if (text.trim()) {
                resendText = text;
              }
            },
            onRecordError: (error) =>
              ctx.log?.error?.(`reef rejection notice record failed: ${String(error)}`),
            onDispatchError: (error) => {
              dispatchFailure ??= new Error("Reef rejection notice dispatch failed", {
                cause: error,
              });
              ctx.log?.error?.(`reef rejection notice dispatch failed: ${String(error)}`);
            },
          });
          if (dispatchFailure) {
            throw dispatchFailure;
          }
          if (notice.allowResend && isRephrasedReefResend(resendText, notice.originalTextHash)) {
            // A guard-recovery send gets one attempt. Its own rejection must
            // notify the agent but never open another automatic resend turn.
            await flow.send(notice.peer, resendText, {
              replyTo: notice.messageId,
              expectedRecipient: notice.recipient,
              resendDisabled: true,
            });
          }
        },
        {
          loadState: (peer) => trust.rejectionNoticeState(peer),
          reserve: (rejection, noticeState) =>
            trust.reserveOutboundRejectionNotice(
              rejection.peer,
              rejection.id,
              rejection.recipient,
              noticeState,
            ),
          complete: (rejection, noticeState) => {
            // Persist cooldown before deleting the reservation. A crash between
            // those writes leaves stop-only recovery, never another resend grant.
            if (!trust.completeOutboundRejection(rejection.peer, rejection.id, noticeState)) {
              throw new Error(`Reef rejection ${rejection.id} lost its durable delivery state`);
            }
          },
        },
        {
          onError: (error, receiptId) =>
            ctx.log?.error?.(`reef rejection notice failed for ${receiptId}: ${String(error)}`),
          signal: ctx.abortSignal,
        },
      );
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
      // Attempt the peer-key refresh before recovery can dispatch an agent
      // turn. The lifecycle activates only after that attempt is classified.
      // The lifecycle owns both the ordering and the reconcile failure policy.
      const activate = async () => {
        await receiptNotifier.notifyRejections(trust.pendingOutboundRejections());
        if (ctx.abortSignal.aborted) {
          return;
        }
        setActiveReef({ flow, friends, reviews });
        ctx.setStatus({ accountId: "default", running: true, connected: false });
      };
      const inbox = new ReefInboxConnection(
        transport,
        (entries) =>
          processReefInboxEntriesInOrder({
            entries,
            processEntries: (batch) => flow.processEntries(batch),
            notifyRejections: (rejections) => receiptNotifier.notifyRejections(rejections),
            onNoticeError: (error) =>
              ctx.log?.error?.(`reef rejection notice processing failed: ${String(error)}`),
          }),
        createReefWebSocket,
        {
          initialCursor: inboxCursor.load(),
          persistCursor: (cursor) => inboxCursor.advance(cursor),
          onState: (state) => {
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
                    lastError: null,
                  }
                : { accountId: "default", running: true, connected: false },
            );
          },
          onError: (error) => {
            if (ctx.abortSignal.aborted) {
              return;
            }
            ctx.log?.error?.(`reef inbox connection failed: ${error.message}`);
            ctx.setStatus({
              accountId: "default",
              running: true,
              connected: false,
              lastError: error.message,
            });
          },
        },
      );
      try {
        await runReefChannelLifecycle({
          parentSignal: ctx.abortSignal,
          startInbox: (signal) => inbox.start(signal),
          reconcile: async () => {
            // The overdue sweep must run even while the relay is unreachable:
            // that outage is exactly when queued sends go unconfirmed, and the
            // notices themselves are local.
            let reconcileError: Error | undefined;
            try {
              await reconcile();
            } catch (error) {
              reconcileError = error instanceof Error ? error : new Error(String(error));
            }
            await notifyOverdueReefDeliveries({ trust, ownerNotice });
            if (reconcileError) {
              throw reconcileError;
            }
          },
          onReconcileError: (error) =>
            ctx.log?.error?.(`reef friend reconcile failed: ${String(error)}`),
          shouldContinueAfterStartupReconcileError: isRetryableReefRelayFailure,
          onReady: activate,
        });
      } finally {
        ctx.setStatus({ accountId: "default", running: false, connected: false });
      }
    },
  },
};
