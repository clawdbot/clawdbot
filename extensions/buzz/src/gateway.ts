import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { computeBackoff, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type { ChannelGatewayContext } from "../runtime-api.js";
import { sendBuzzTextOneShot, startBuzzBus, type BuzzBus } from "./buzz-bus.js";
import { handleBuzzInbound } from "./inbound.js";
import { getBuzzRuntime } from "./runtime.js";
import { buildBuzzTarget, isConfiguredBuzzChannel, parseBuzzTarget } from "./target.js";
import {
  resolveBuzzAccount,
  resolveDefaultBuzzAccountId,
  type ResolvedBuzzAccount,
} from "./types.js";

const activeBuses = new Map<string, BuzzBus>();
const RECONNECT_BACKOFF = {
  initialMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.2,
} as const;
const RECONNECT_STABLE_MS = 60_000;
const RECONNECT_LOOKBACK_SECONDS = 24 * 60 * 60;

function resolveBuzzProfileName(params: {
  cfg: OpenClawConfig;
  account: ResolvedBuzzAccount;
  channelIds: string[];
}): string {
  const explicitName = params.account.config.name?.trim();
  if (explicitName) {
    return explicitName;
  }
  const runtime = getBuzzRuntime();
  const agentIds = new Set(
    params.channelIds.map(
      (channelId) =>
        runtime.channel.routing.resolveAgentRoute({
          cfg: params.cfg,
          channel: "buzz",
          accountId: params.account.accountId,
          peer: { kind: "group", id: buildBuzzTarget(channelId) },
        }).agentId,
    ),
  );
  if (agentIds.size !== 1) {
    return "OpenClaw";
  }
  const agentId = agentIds.values().next().value;
  return agentId
    ? runtime.agent.resolveAgentIdentity(params.cfg, agentId)?.name?.trim() || "OpenClaw"
    : "OpenClaw";
}

export async function startBuzzGatewayAccount(ctx: ChannelGatewayContext<ResolvedBuzzAccount>) {
  const account = resolveBuzzAccount({
    cfg: ctx.cfg,
    accountId: ctx.account.accountId,
  });
  if (!account.configured) {
    throw new Error(`Buzz is not configured for account "${account.accountId}"`);
  }
  const channelIds = Object.entries(account.config.groups ?? {})
    .filter(([, config]) => config.enabled !== false)
    .map(([channelId]) => parseBuzzTarget(channelId));
  if (channelIds.length === 0) {
    throw new Error("Buzz requires at least one channels.buzz.groups entry");
  }
  const configuredChannelIds = new Set(channelIds);
  const profileName = resolveBuzzProfileName({ cfg: ctx.cfg, account, channelIds });

  let hasAttemptedSession = false;
  let reconnectAttempt = 0;
  while (!ctx.abortSignal.aborted) {
    let bus: BuzzBus | undefined;
    let cycleError: Error | undefined;
    let connectedAt: number | undefined;
    let reportBusFailure: (error: Error) => void = () => {};
    const busFailure = new Promise<Error>((resolve) => {
      reportBusFailure = resolve;
    });
    try {
      const sessionSince =
        Math.floor(Date.now() / 1000) - (hasAttemptedSession ? RECONNECT_LOOKBACK_SECONDS : 0);
      hasAttemptedSession = true;
      bus = await startBuzzBus({
        accountId: account.accountId,
        relayUrl: account.relayUrl,
        privateKey: account.privateKey,
        authTag: account.authTag,
        profileName,
        channelIds,
        since: sessionSince,
        signal: ctx.abortSignal,
        onMessage: async (message, sessionBus) => {
          // Subscription filters reduce traffic, but relay events remain untrusted.
          if (!isConfiguredBuzzChannel(configuredChannelIds, message.channelId)) {
            return;
          }
          await handleBuzzInbound({ account, cfg: ctx.cfg, bus: sessionBus, message });
        },
        onMessageError: (error) => {
          ctx.log?.error?.(`[${account.accountId}] Buzz message failed: ${error.message}`);
        },
        onFatalError: (error) => {
          ctx.log?.error?.(`[${account.accountId}] Buzz bus failed: ${error.message}`);
          reportBusFailure(error);
        },
        onDedupeError: (error) => {
          ctx.log?.error?.(`[${account.accountId}] Buzz replay state failed: ${error.message}`);
        },
        onPresenceError: (error) => {
          ctx.log?.warn?.(
            `[${account.accountId}] Buzz presence heartbeat failed: ${error.message}`,
          );
        },
        onProfilePublished: () => {
          ctx.log?.info?.(`[${account.accountId}] Buzz bot profile published as "${profileName}"`);
        },
        onProfileError: (error) => {
          ctx.log?.warn?.(`[${account.accountId}] Buzz bot profile sync failed: ${error.message}`);
        },
      });
      connectedAt = Date.now();
      activeBuses.set(account.accountId, bus);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        configured: true,
        enabled: account.enabled,
        baseUrl: account.relayUrl,
        publicKey: bus.publicKey,
        lastError: null,
      });
      ctx.log?.info?.(
        `[${account.accountId}] Buzz connected to ${account.relayUrl} for ${channelIds.length} channel(s)`,
      );
      const fatalError = await Promise.race([
        waitUntilAbort(ctx.abortSignal).then(() => undefined),
        busFailure,
      ]);
      if (fatalError) {
        throw fatalError;
      }
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        return;
      }
      cycleError = error instanceof Error ? error : new Error(String(error));
    } finally {
      await bus?.close();
      if (activeBuses.get(account.accountId) === bus) {
        activeBuses.delete(account.accountId);
      }
      ctx.setStatus({
        accountId: account.accountId,
        running: false,
        ...(cycleError ? { lastError: cycleError.message } : {}),
      });
    }
    if (!cycleError || ctx.abortSignal.aborted) {
      return;
    }
    if (connectedAt !== undefined && Date.now() - connectedAt >= RECONNECT_STABLE_MS) {
      reconnectAttempt = 0;
    }
    reconnectAttempt += 1;
    const delayMs = computeBackoff(RECONNECT_BACKOFF, reconnectAttempt);
    ctx.log?.info?.(
      `[${account.accountId}] Buzz reconnecting in ${delayMs}ms after: ${cycleError.message}`,
    );
    try {
      await sleepWithAbort(delayMs, ctx.abortSignal);
    } catch {
      if (!ctx.abortSignal.aborted) {
        throw cycleError;
      }
    }
  }
}

export const buzzOutboundAdapter = {
  deliveryMode: "direct" as const,
  textChunkLimit: 16_000,
  deliveryCapabilities: {
    durableFinal: {
      text: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  sendText: async ({
    cfg,
    to,
    text,
    accountId,
    threadId,
    replyToId,
  }: {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    accountId?: string | null;
    threadId?: string | number | null;
    replyToId?: string | number | null;
  }) => {
    const runtime = getBuzzRuntime();
    const resolvedAccountId = accountId ?? resolveDefaultBuzzAccountId(cfg);
    const account = resolveBuzzAccount({ cfg, accountId: resolvedAccountId });
    if (!account.enabled) {
      throw new Error(`Buzz is disabled for account ${resolvedAccountId}`);
    }
    if (!account.configured) {
      throw new Error(`Buzz is not configured for account ${resolvedAccountId}`);
    }
    const bus = activeBuses.get(resolvedAccountId);
    const channelId = parseBuzzTarget(to);
    const tableMode = runtime.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "buzz",
      accountId: resolvedAccountId,
    });
    const message = runtime.channel.text.convertMarkdownTables(text ?? "", tableMode);
    const outboundMessage = {
      channelId,
      text: message,
      threadId: threadId == null ? undefined : String(threadId),
      replyToId: replyToId == null ? undefined : String(replyToId),
    };
    const messageId = bus
      ? await bus.sendText(outboundMessage)
      : await sendBuzzTextOneShot({
          relayUrl: account.relayUrl,
          privateKey: account.privateKey,
          authTag: account.authTag,
          ...outboundMessage,
        });
    return attachChannelToResult("buzz", { to: channelId, messageId });
  },
};

export async function sendBuzzTyping(params: {
  cfg: OpenClawConfig;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
}): Promise<void> {
  const resolvedAccountId = params.accountId ?? resolveDefaultBuzzAccountId(params.cfg);
  const bus = activeBuses.get(resolvedAccountId);
  if (!bus) {
    return;
  }
  await bus.sendTyping({
    channelId: parseBuzzTarget(params.to),
    threadId: params.threadId == null ? undefined : String(params.threadId),
  });
}
