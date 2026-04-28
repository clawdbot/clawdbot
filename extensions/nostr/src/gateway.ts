import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  createPreCryptoDirectDmAuthorizer,
  DEFAULT_ACCOUNT_ID,
  type ChannelOutboundAdapter,
  resolveInboundDirectDmAccessWithRuntime,
  type ChannelPlugin,
} from "./channel-api.js";
import type { MetricEvent, MetricsSnapshot } from "./metrics.js";
import { startNostrBus, type NostrBusHandle } from "./nostr-bus.js";
import { normalizePubkey } from "./nostr-key-utils.js";
import { getNostrRuntime } from "./runtime.js";
import { resolveDefaultNostrAccountId, type ResolvedNostrAccount } from "./types.js";

type NostrGatewayStart = NonNullable<
  NonNullable<ChannelPlugin<ResolvedNostrAccount>["gateway"]>["startAccount"]
>;
type NostrOutboundAdapter = Pick<
  ChannelOutboundAdapter,
  "deliveryMode" | "textChunkLimit" | "sendText"
> & {
  sendText: NonNullable<ChannelOutboundAdapter["sendText"]>;
};

const activeBuses = new Map<string, NostrBusHandle>();
const metricsSnapshots = new Map<string, MetricsSnapshot>();

function normalizeNostrAllowEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  try {
    return normalizePubkey(trimmed.replace(/^nostr:/i, ""));
  } catch {
    return null;
  }
}

function isNostrSenderAllowed(senderPubkey: string, allowFrom: string[]): boolean {
  const normalizedSender = normalizePubkey(senderPubkey);
  for (const entry of allowFrom) {
    const normalized = normalizeNostrAllowEntry(entry);
    if (normalized === "*" || normalized === normalizedSender) {
      return true;
    }
  }
  return false;
}

async function resolveNostrDirectAccess(params: {
  cfg: OpenClawConfig;
  accountId: string;
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom: Array<string | number> | undefined;
  senderPubkey: string;
  rawBody: string;
  runtime: Parameters<typeof resolveInboundDirectDmAccessWithRuntime>[0]["runtime"];
}) {
  return resolveInboundDirectDmAccessWithRuntime({
    cfg: params.cfg,
    channel: "nostr",
    accountId: params.accountId,
    dmPolicy: params.dmPolicy,
    allowFrom: params.allowFrom,
    senderId: params.senderPubkey,
    rawBody: params.rawBody,
    isSenderAllowed: isNostrSenderAllowed,
    runtime: params.runtime,
    modeWhenAccessGroupsOff: "configured",
  });
}

export const startNostrGatewayAccount: NostrGatewayStart = async (ctx) => {
  const account = ctx.account;
  ctx.setStatus({
    accountId: account.accountId,
    publicKey: account.publicKey,
  });
  ctx.log?.info?.(`[${account.accountId}] starting Nostr provider (pubkey: ${account.publicKey})`);

  if (!account.configured) {
    throw new Error("Nostr private key not configured");
  }

  const runtime = getNostrRuntime();
  const pairing = createChannelPairingController({
    core: runtime,
    channel: "nostr",
    accountId: account.accountId,
  });
  const resolveInboundAccess = async (senderPubkey: string, rawBody: string) =>
    await resolveNostrDirectAccess({
      cfg: ctx.cfg,
      accountId: account.accountId,
      dmPolicy: account.config.dmPolicy ?? "pairing",
      allowFrom: account.config.allowFrom,
      senderPubkey,
      rawBody,
      runtime: {
        shouldComputeCommandAuthorized: runtime.channel.commands.shouldComputeCommandAuthorized,
        resolveCommandAuthorizedFromAuthorizers:
          runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers,
      },
    });

  let busHandle: NostrBusHandle | null = null;

  const authorizeSender = createPreCryptoDirectDmAuthorizer({
    resolveAccess: async (senderPubkey) => await resolveInboundAccess(senderPubkey, ""),
    issuePairingChallenge: async ({ senderId, reply }) => {
      await pairing.issueChallenge({
        senderId,
        senderIdLine: `Your Nostr pubkey: ${senderId}`,
        sendPairingReply: reply,
        onCreated: () => {
          ctx.log?.debug?.(`[${account.accountId}] nostr pairing request sender=${senderId}`);
        },
        onReplyError: (err) => {
          ctx.log?.warn?.(
            `[${account.accountId}] nostr pairing reply failed for ${senderId}: ${String(err)}`,
          );
        },
      });
    },
    onBlocked: ({ senderId, reason }) => {
      ctx.log?.debug?.(`[${account.accountId}] blocked Nostr sender ${senderId} (${reason})`);
    },
  });

  const bus = await startNostrBus({
    accountId: account.accountId,
    privateKey: account.privateKey,
    relays: account.relays,
    authorizeSender: async ({ senderPubkey, reply }) =>
      await authorizeSender({ senderId: senderPubkey, reply }),
    onMessage: async (senderPubkey, text, reply, meta) => {
      const resolvedAccess = await resolveInboundAccess(senderPubkey, text);
      if (resolvedAccess.access.decision !== "allow") {
        ctx.log?.warn?.(
          `[${account.accountId}] dropping Nostr DM after preflight drift (${senderPubkey}, ${resolvedAccess.access.reason})`,
        );
        return;
      }

      const { dispatchInboundDirectDmWithRuntime } = await import("./inbound-direct-dm-runtime.js");
      await dispatchInboundDirectDmWithRuntime({
        cfg: ctx.cfg,
        runtime,
        channel: "nostr",
        channelLabel: "Nostr",
        accountId: account.accountId,
        peer: {
          kind: "direct",
          id: senderPubkey,
        },
        senderId: senderPubkey,
        senderAddress: `nostr:${senderPubkey}`,
        recipientAddress: `nostr:${account.publicKey}`,
        conversationLabel: senderPubkey,
        rawBody: text,
        messageId: meta.eventId,
        timestamp: meta.createdAt * 1000,
        commandAuthorized: resolvedAccess.commandAuthorized,
        deliver: async (payload) => {
          const outboundText =
            payload && typeof payload === "object" && "text" in payload
              ? ((payload as { text?: string }).text ?? "")
              : "";
          if (!outboundText.trim()) {
            return;
          }
          const tableMode = runtime.channel.text.resolveMarkdownTableMode({
            cfg: ctx.cfg,
            channel: "nostr",
            accountId: account.accountId,
          });
          await reply(runtime.channel.text.convertMarkdownTables(outboundText, tableMode));
        },
        onRecordError: (err) => {
          ctx.log?.error?.(
            `[${account.accountId}] failed recording Nostr inbound session: ${String(err)}`,
          );
        },
        onDispatchError: (err, info) => {
          ctx.log?.error?.(
            `[${account.accountId}] Nostr ${info.kind} reply failed: ${String(err)}`,
          );
        },
      });
    },
    onError: (error, context) => {
      ctx.log?.error?.(`[${account.accountId}] Nostr error (${context}): ${error.message}`);
    },
    onConnect: (relay) => {
      ctx.log?.debug?.(`[${account.accountId}] Connected to relay: ${relay}`);
    },
    onDisconnect: (relay) => {
      ctx.log?.debug?.(`[${account.accountId}] Disconnected from relay: ${relay}`);
    },
    onEose: (relays) => {
      ctx.log?.debug?.(`[${account.accountId}] EOSE received from relays: ${relays}`);
    },
    onMetric: (event: MetricEvent) => {
      if (event.name.startsWith("event.rejected.")) {
        ctx.log?.debug?.(
          `[${account.accountId}] Metric: ${event.name} ${JSON.stringify(event.labels)}`,
        );
      } else if (event.name === "relay.circuit_breaker.open") {
        ctx.log?.warn?.(
          `[${account.accountId}] Circuit breaker opened for relay: ${event.labels?.relay}`,
        );
      } else if (event.name === "relay.circuit_breaker.close") {
        ctx.log?.info?.(
          `[${account.accountId}] Circuit breaker closed for relay: ${event.labels?.relay}`,
        );
      } else if (event.name === "relay.error") {
        ctx.log?.debug?.(`[${account.accountId}] Relay error: ${event.labels?.relay}`);
      }
      if (busHandle) {
        metricsSnapshots.set(account.accountId, busHandle.getMetrics());
      }
    },
  });

  busHandle = bus;
  activeBuses.set(account.accountId, bus);

  ctx.log?.info?.(
    `[${account.accountId}] Nostr provider started, connected to ${account.relays.length} relay(s)`,
  );

  return {
    stop: () => {
      bus.close();
      activeBuses.delete(account.accountId);
      metricsSnapshots.delete(account.accountId);
      ctx.log?.info?.(`[${account.accountId}] Nostr provider stopped`);
    },
  };
};

export const nostrPairingTextAdapter = {
  idLabel: "nostrPubkey",
  message: "Your pairing request has been approved!",
  normalizeAllowEntry: (entry: string) => {
    try {
      return normalizePubkey(entry.trim().replace(/^nostr:/i, ""));
    } catch {
      return entry.trim();
    }
  },
  notify: async ({
    cfg,
    id,
    message,
    accountId,
  }: {
    cfg: OpenClawConfig;
    id: string;
    message: string;
    accountId?: string;
  }) => {
    const bus = activeBuses.get(accountId ?? resolveDefaultNostrAccountId(cfg));
    if (bus) {
      await bus.sendDm(id, message);
    }
  },
};

export const nostrOutboundAdapter: NostrOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId }) => {
    const core = getNostrRuntime();
    const aid = accountId ?? resolveDefaultNostrAccountId(cfg);
    const bus = activeBuses.get(aid);
    if (!bus) {
      throw new Error(`Nostr bus not running for account ${aid}`);
    }
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "nostr",
      accountId: aid,
    });
    const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
    const normalizedTo = normalizePubkey(to);
    await bus.sendDm(normalizedTo, message);
    return attachChannelToResult("nostr", {
      to: normalizedTo,
      messageId: `nostr-${Date.now()}`,
    });
  },
};

export function getNostrMetrics(
  accountId: string = DEFAULT_ACCOUNT_ID,
): MetricsSnapshot | undefined {
  const bus = activeBuses.get(accountId);
  if (bus) {
    return bus.getMetrics();
  }
  return metricsSnapshots.get(accountId);
}

export function getActiveNostrBuses(): Map<string, NostrBusHandle> {
  return new Map(activeBuses);
}
