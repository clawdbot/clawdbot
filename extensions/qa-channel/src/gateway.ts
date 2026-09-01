// Qa Channel plugin module implements gateway behavior.
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { pollQaBus } from "./bus-client.js";
import { handleQaInbound } from "./inbound.js";
import type { ChannelGatewayContext } from "./runtime-api.js";
import type { CoreConfig, ResolvedQaChannelAccount } from "./types.js";

export async function startQaGatewayAccount(
  channelId: string,
  channelLabel: string,
  ctx: ChannelGatewayContext<ResolvedQaChannelAccount>,
) {
  const account = ctx.account;
  const channelRuntime = ctx.channelRuntime as PluginRuntime["channel"] | undefined;
  const buildContext = channelRuntime?.inbound.buildContext ?? buildChannelInboundEventContext;
  if (!account.configured) {
    throw new Error(`QA channel is not configured for account "${account.accountId}"`);
  }
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    lifecycle: "starting",
    configured: true,
    enabled: account.enabled,
    baseUrl: account.baseUrl,
  });
  let cursor = 0;
  let acknowledgedCursor = 0;
  let committedAcknowledgedCursor = 0;
  let queuedAcknowledgedCursor = 0;
  let acknowledgementStopped = false;
  let ready = false;
  let inboundError: Error | undefined;
  let queuedInbound = Promise.resolve();
  let queuedAcknowledgements = Promise.resolve();
  const controlTasks = new Set<Promise<boolean>>();
  const handleMessage = (message: Parameters<typeof handleQaInbound>[0]["message"]) =>
    handleQaInbound({
      channelId,
      channelLabel,
      account,
      config: ctx.cfg as CoreConfig,
      message,
      buildContext,
      ...(channelRuntime ? { channelRuntime } : {}),
    });
  const captureInboundError = (error: unknown) => {
    inboundError ??= error instanceof Error ? error : new Error(String(error));
  };
  const dispatchControl = (message: Parameters<typeof handleQaInbound>[0]["message"]) => {
    const task = handleMessage(message)
      .then(
        () => true,
        (error: unknown) => {
          captureInboundError(error);
          return false;
        },
      )
      .finally(() => controlTasks.delete(task));
    controlTasks.add(task);
    return task;
  };
  const enqueueInbound = (message: Parameters<typeof handleQaInbound>[0]["message"]) => {
    let handled = false;
    queuedInbound = queuedInbound
      .then(async () => {
        if (inboundError) {
          return;
        }
        await handleMessage(message);
        handled = true;
      })
      .catch(captureInboundError);
    return queuedInbound.then(() => handled);
  };
  const acknowledgeProcessedEvent = (eventCursor: number, task?: Promise<boolean>) => {
    if (eventCursor <= queuedAcknowledgedCursor) {
      return;
    }
    queuedAcknowledgedCursor = eventCursor;
    // Dispatch may run ahead for native controls, but restart recovery can
    // advance only through the contiguous successfully handled prefix.
    queuedAcknowledgements = queuedAcknowledgements.then(async () => {
      if (acknowledgementStopped) {
        return;
      }
      if (task && !(await task)) {
        acknowledgementStopped = true;
        return;
      }
      acknowledgedCursor = eventCursor;
    });
  };
  try {
    while (!ctx.abortSignal.aborted) {
      if (inboundError) {
        throw inboundError;
      }
      const pollAcknowledgedCursor = acknowledgedCursor;
      const result = await pollQaBus({
        baseUrl: account.baseUrl,
        accountId: account.accountId,
        cursor,
        acknowledgedCursor: pollAcknowledgedCursor,
        timeoutMs: account.pollTimeoutMs,
        signal: ctx.abortSignal,
      });
      committedAcknowledgedCursor = Math.max(committedAcknowledgedCursor, pollAcknowledgedCursor);
      if (!ready) {
        ready = true;
        ctx.setStatus(channelReadyPatch({ accountId: account.accountId }));
      }
      cursor = result.cursor;
      for (const event of result.events) {
        if (event.kind !== "inbound-message") {
          acknowledgeProcessedEvent(event.cursor);
          continue;
        }
        if (event.message.nativeCommand) {
          acknowledgeProcessedEvent(event.cursor, dispatchControl(event.message));
        } else {
          acknowledgeProcessedEvent(event.cursor, enqueueInbound(event.message));
        }
      }
      acknowledgeProcessedEvent(cursor);
    }
    if (inboundError) {
      throw inboundError;
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") {
      ctx.setStatus({
        accountId: account.accountId,
        connected: false,
        lifecycle: "recovering",
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  } finally {
    try {
      await Promise.all([queuedInbound, queuedAcknowledgements, ...controlTasks]);
      if (acknowledgedCursor > committedAcknowledgedCursor) {
        // The aborted poll cannot carry work completed during shutdown. Flush
        // that fact without its cancelled signal before publishing stopped.
        await pollQaBus({
          baseUrl: account.baseUrl,
          accountId: account.accountId,
          cursor,
          acknowledgedCursor,
          timeoutMs: 0,
        });
      }
    } catch (error) {
      captureInboundError(error);
    } finally {
      ctx.setStatus(channelStoppedPatch({ accountId: account.accountId }));
    }
  }
  if (inboundError) {
    throw inboundError;
  }
}
