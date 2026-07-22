import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { computeBackoff, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type { ChannelGatewayContext } from "../runtime-api.js";
import { startBuzzBus, type BuzzBus } from "./buzz-bus.js";
import { handleBuzzInbound } from "./inbound.js";
import { getBuzzRuntime } from "./runtime.js";
import { isConfiguredBuzzChannel, parseBuzzTarget } from "./target.js";
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

  let hasAttemptedSession = false;
  let reconnectAttempt = 0;
  while (!ctx.abortSignal.aborted) {
    let bus: BuzzBus | undefined;
    let cycleError: Error | undefined;
    let connectedAt: number | undefined;
    let rejectBusFailure: (error: Error) => void = () => {};
    const busFailure = new Promise<never>((_, reject) => {
      rejectBusFailure = reject;
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
          rejectBusFailure(error);
        },
        onDedupeError: (error) => {
          ctx.log?.error?.(`[${account.accountId}] Buzz replay state failed: ${error.message}`);
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
      });
      ctx.log?.info?.(
        `[${account.accountId}] Buzz connected to ${account.relayUrl} for ${channelIds.length} channel(s)`,
      );
      await Promise.race([waitUntilAbort(ctx.abortSignal), busFailure]);
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
    const bus = activeBuses.get(resolvedAccountId);
    if (!bus) {
      throw new Error(`Buzz bus not running for account ${resolvedAccountId}`);
    }
    const channelId = parseBuzzTarget(to);
    const tableMode = runtime.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "buzz",
      accountId: resolvedAccountId,
    });
    const message = runtime.channel.text.convertMarkdownTables(text ?? "", tableMode);
    const messageId = await bus.sendText({
      channelId,
      text: message,
      threadId: threadId == null ? undefined : String(threadId),
      replyToId: replyToId == null ? undefined : String(replyToId),
    });
    return attachChannelToResult("buzz", { to: channelId, messageId });
  },
};
