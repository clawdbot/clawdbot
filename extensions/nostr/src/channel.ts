import {
  buildChannelConfigSchema,
  createReplyPrefixContext,
  createTypingCallbacks,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  logTypingFailure,
  type ChannelPlugin,
} from "clawdbot/plugin-sdk";

import { NostrConfigSchema } from "./config-schema.js";
import { getNostrRuntime } from "./runtime.js";
import {
  listNostrAccountIds,
  resolveDefaultNostrAccountId,
  resolveNostrAccount,
  type ResolvedNostrAccount,
} from "./types.js";
import { normalizePubkey, startNostrBus, type NostrBusHandle } from "./nostr-bus.js";
import type { MetricEvent, MetricsSnapshot } from "./metrics.js";
import type { NostrProfile } from "./config-schema.js";
import type { ProfilePublishResult } from "./nostr-profile.js";

// Store active bus handles per account
const activeBuses = new Map<string, NostrBusHandle>();

// Store metrics snapshots per account (for status reporting)
const metricsSnapshots = new Map<string, MetricsSnapshot>();

export const nostrPlugin: ChannelPlugin<ResolvedNostrAccount> = {
  id: "nostr",
  meta: {
    id: "nostr",
    label: "Nostr",
    selectionLabel: "Nostr",
    docsPath: "/channels/nostr",
    docsLabel: "nostr",
    blurb: "Decentralized DMs via Nostr relays (NIP-04)",
    order: 100,
  },
  capabilities: {
    chatTypes: ["direct"], // DMs only for MVP
    media: false, // No media for MVP
  },
  reload: { configPrefixes: ["channels.nostr"] },
  configSchema: buildChannelConfigSchema(NostrConfigSchema),

  config: {
    listAccountIds: (cfg) => listNostrAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveNostrAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultNostrAccountId(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveNostrAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry)
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => {
          if (entry === "*") return "*";
          try {
            return normalizePubkey(entry);
          } catch {
            return entry; // Keep as-is if normalization fails
          }
        })
        .filter(Boolean),
  },

  pairing: {
    idLabel: "nostrPubkey",
    normalizeAllowEntry: (entry) => {
      try {
        return normalizePubkey(entry.replace(/^nostr:/i, ""));
      } catch {
        return entry;
      }
    },
    notifyApproval: async ({ id }) => {
      // Get the default account's bus and send approval message
      const bus = activeBuses.get(DEFAULT_ACCOUNT_ID);
      if (bus) {
        await bus.sendDm(id, "Your pairing request has been approved!");
      }
    },
  },

  security: {
    resolveDmPolicy: ({ account }) => {
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: "channels.nostr.dmPolicy",
        allowFromPath: "channels.nostr.allowFrom",
        approveHint: formatPairingApproveHint("nostr"),
        normalizeEntry: (raw) => {
          try {
            return normalizePubkey(raw.replace(/^nostr:/i, "").trim());
          } catch {
            return raw.trim();
          }
        },
      };
    },
  },

  messaging: {
    normalizeTarget: (target) => {
      // Strip nostr: prefix if present
      const cleaned = target.replace(/^nostr:/i, "").trim();
      try {
        return normalizePubkey(cleaned);
      } catch {
        return cleaned;
      }
    },
    targetResolver: {
      looksLikeId: (input) => {
        const trimmed = input.trim();
        return trimmed.startsWith("npub1") || /^[0-9a-fA-F]{64}$/.test(trimmed);
      },
      hint: "<npub|hex pubkey|nostr:npub...>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const core = getNostrRuntime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`Nostr bus not running for account ${aid}`);
      }
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg: core.config.loadConfig(),
        channel: "nostr",
        accountId: aid,
      });
      const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
      const normalizedTo = normalizePubkey(to);
      await bus.sendDm(normalizedTo, message);
      return { channel: "nostr", to: normalizedTo };
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
            channel: "nostr",
            accountId: account.accountId,
            kind: "runtime" as const,
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      publicKey: snapshot.publicKey ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey,
      profile: account.profile,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        publicKey: account.publicKey,
      });
      ctx.log?.info(`[${account.accountId}] starting Nostr provider (pubkey: ${account.publicKey})`);

      if (!account.configured) {
        throw new Error("Nostr private key not configured");
      }

      const runtime = getNostrRuntime();

      // Track bus handle for metrics callback
      let busHandle: NostrBusHandle | null = null;

      const bus = await startNostrBus({
        accountId: account.accountId,
        privateKey: account.privateKey,
        relays: account.relays,
        onMessage: async (senderPubkey, text, reply, eventId) => {
          ctx.log?.debug(`[${account.accountId}] DM from ${senderPubkey}: ${text.slice(0, 50)}...`);

          const cfg = runtime.config.loadConfig();
          const route = runtime.channel.routing.resolveAgentRoute({
            cfg,
            channel: "nostr",
            accountId: account.accountId,
            peer: { kind: "dm", id: senderPubkey },
          });

          ctx.log?.debug(`[${account.accountId}] Route resolved: sessionKey=${route.sessionKey}, agentId=${route.agentId}`);

          const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
            agentId: route.agentId,
          });
          const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
          const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
            storePath,
            sessionKey: route.sessionKey,
          });
          const body = runtime.channel.reply.formatAgentEnvelope({
            channel: "Nostr",
            from: senderPubkey,
            timestamp: Date.now(),
            previousTimestamp,
            envelope: envelopeOptions,
            body: text,
          });

          // Create typing callbacks for this conversation
          // Note: busHandle is checked at invocation time (not creation time)
          // to handle the race condition during startup
          const typingCallbacks = createTypingCallbacks({
            start: async () => {
              if (!busHandle) {
                ctx.log?.debug(`[${account.accountId}] Skipping typing START (bus not ready)`);
                return;
              }
              ctx.log?.debug(`[${account.accountId}] Sending typing START to ${senderPubkey.slice(0, 8)}`);
              return busHandle.sendTypingStart(senderPubkey);
            },
            stop: async () => {
              if (!busHandle) {
                ctx.log?.debug(`[${account.accountId}] Skipping typing STOP (bus not ready)`);
                return;
              }
              ctx.log?.debug(`[${account.accountId}] Sending typing STOP to ${senderPubkey.slice(0, 8)}`);
              return busHandle.sendTypingStop(senderPubkey);
            },
            onStartError: (err) =>
              logTypingFailure({
                log: (msg) => ctx.log?.warn(msg),
                channel: "nostr",
                target: senderPubkey,
                action: "start",
                error: err,
              }),
            onStopError: (err) =>
              logTypingFailure({
                log: (msg) => ctx.log?.warn(msg),
                channel: "nostr",
                target: senderPubkey,
                action: "stop",
                error: err,
              }),
          });

          // Build the inbound message context
          const ctxPayload = runtime.channel.reply.finalizeInboundContext({
            Body: body,
            RawBody: text,
            CommandBody: text,
            From: `nostr:${senderPubkey}`,
            To: `nostr:${senderPubkey}`,
            SessionKey: route.sessionKey,
            AccountId: account.accountId,
            ChatType: "direct",
            ConversationLabel: senderPubkey,
            SenderName: senderPubkey.slice(0, 8),
            SenderId: senderPubkey,
            Provider: "nostr" as const,
            Surface: "nostr" as const,
            Timestamp: Date.now(),
            MessageSid: eventId, // Nostr event ID for deduplication
            CommandAuthorized: true, // TODO: implement proper authorization
            CommandSource: "text" as const,
            OriginatingChannel: "nostr" as const,
            OriginatingTo: `nostr:${senderPubkey}`,
          });

          await runtime.channel.session.recordInboundSession({
            storePath,
            sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
            ctx: ctxPayload,
            updateLastRoute: {
              sessionKey: route.mainSessionKey,
              channel: "nostr",
              to: `nostr:${senderPubkey}`,
              accountId: route.accountId,
            },
            onRecordError: (err) => {
              ctx.log?.warn?.(`nostr: failed updating session meta: ${String(err)}`);
            },
          });

          // Get table mode for formatting
          const tableMode = runtime.channel.text.resolveMarkdownTableMode({
            cfg,
            channel: "nostr",
            accountId: account.accountId,
          });

          // Create reply prefix context
          const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });

          // Create the reply dispatcher
          const { dispatcher, replyOptions, markDispatchIdle } =
            runtime.channel.reply.createReplyDispatcherWithTyping({
              responsePrefix: prefixContext.responsePrefix,
              responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
              humanDelay: runtime.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
              deliver: async (payload) => {
                const message = runtime.channel.text.convertMarkdownTables(
                  payload.text ?? "",
                  tableMode
                );
                if (!message) return;
                ctx.log?.debug(`[${account.accountId}] Delivering reply to ${senderPubkey.slice(0, 8)}: ${message.slice(0, 50)}...`);
                await reply(message);
                ctx.log?.info(`[${account.accountId}] Reply delivered to ${senderPubkey.slice(0, 8)}`);
              },
              onError: (err, info) => {
                ctx.log?.error(`[${account.accountId}] nostr ${info.kind} reply failed: ${String(err)}`);
              },
              onReplyStart: typingCallbacks?.onReplyStart,
              onIdle: typingCallbacks?.onIdle,
            });

          // Dispatch the reply
          const { queuedFinal, counts } = await runtime.channel.reply.dispatchReplyFromConfig({
            ctx: ctxPayload,
            cfg,
            dispatcher,
            replyOptions: {
              ...replyOptions,
              onModelSelected: prefixContext.onModelSelected,
            },
          });
        },
        onError: (error, context) => {
          ctx.log?.error(`[${account.accountId}] Nostr error (${context}): ${error.message}`);
        },
        onConnect: (relay) => {
          ctx.log?.debug(`[${account.accountId}] Connected to relay: ${relay}`);
        },
        onDisconnect: (relay) => {
          ctx.log?.debug(`[${account.accountId}] Disconnected from relay: ${relay}`);
        },
        onEose: (relays) => {
          ctx.log?.debug(`[${account.accountId}] EOSE received from relays: ${relays}`);
        },
        onMetric: (event: MetricEvent) => {
          // Log significant metrics at appropriate levels
          if (event.name.startsWith("event.rejected.")) {
            ctx.log?.debug(`[${account.accountId}] Metric: ${event.name}`, event.labels);
          } else if (event.name === "relay.circuit_breaker.open") {
            ctx.log?.warn(`[${account.accountId}] Circuit breaker opened for relay: ${event.labels?.relay}`);
          } else if (event.name === "relay.circuit_breaker.close") {
            ctx.log?.info(`[${account.accountId}] Circuit breaker closed for relay: ${event.labels?.relay}`);
          } else if (event.name === "relay.error") {
            ctx.log?.debug(`[${account.accountId}] Relay error: ${event.labels?.relay}`);
          }
          // Update cached metrics snapshot
          if (busHandle) {
            metricsSnapshots.set(account.accountId, busHandle.getMetrics());
          }
        },
      });

      busHandle = bus;

      // Store the bus handle
      activeBuses.set(account.accountId, bus);

      ctx.log?.info(`[${account.accountId}] Nostr provider started, connected to ${account.relays.length} relay(s)`);

      // Return cleanup function
      return {
        stop: () => {
          bus.close();
          activeBuses.delete(account.accountId);
          metricsSnapshots.delete(account.accountId);
          ctx.log?.info(`[${account.accountId}] Nostr provider stopped`);
        },
      };
    },
  },
};

/**
 * Get metrics snapshot for a Nostr account.
 * Returns undefined if account is not running.
 */
export function getNostrMetrics(accountId: string = DEFAULT_ACCOUNT_ID): MetricsSnapshot | undefined {
  const bus = activeBuses.get(accountId);
  if (bus) {
    return bus.getMetrics();
  }
  return metricsSnapshots.get(accountId);
}

/**
 * Get all active Nostr bus handles.
 * Useful for debugging and status reporting.
 */
export function getActiveNostrBuses(): Map<string, NostrBusHandle> {
  return new Map(activeBuses);
}

/**
 * Publish a profile (kind:0) for a Nostr account.
 * @param accountId - Account ID (defaults to "default")
 * @param profile - Profile data to publish
 * @returns Publish results with successes and failures
 * @throws Error if account is not running
 */
export async function publishNostrProfile(
  accountId: string = DEFAULT_ACCOUNT_ID,
  profile: NostrProfile
): Promise<ProfilePublishResult> {
  const bus = activeBuses.get(accountId);
  if (!bus) {
    throw new Error(`Nostr bus not running for account ${accountId}`);
  }
  return bus.publishProfile(profile);
}

/**
 * Get profile publish state for a Nostr account.
 * @param accountId - Account ID (defaults to "default")
 * @returns Profile publish state or null if account not running
 */
export async function getNostrProfileState(
  accountId: string = DEFAULT_ACCOUNT_ID
): Promise<{
  lastPublishedAt: number | null;
  lastPublishedEventId: string | null;
  lastPublishResults: Record<string, "ok" | "failed" | "timeout"> | null;
} | null> {
  const bus = activeBuses.get(accountId);
  if (!bus) {
    return null;
  }
  return bus.getProfileState();
}
