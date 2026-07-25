// Qa Channel plugin module implements gateway behavior.
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
  if (!account.configured) {
    throw new Error(`QA channel is not configured for account "${account.accountId}"`);
  }
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    configured: true,
    enabled: account.enabled,
    baseUrl: account.baseUrl,
  });
  let cursor = 0;
  let inboundError: Error | undefined;
  let queuedInbound = Promise.resolve();
  const controlTasks = new Set<Promise<void>>();
  const handleMessage = (message: Parameters<typeof handleQaInbound>[0]["message"]) =>
    handleQaInbound({
      channelId,
      channelLabel,
      account,
      config: ctx.cfg as CoreConfig,
      message,
    });
  const captureInboundError = (error: unknown) => {
    inboundError ??= error instanceof Error ? error : new Error(String(error));
  };
  const dispatchControl = (message: Parameters<typeof handleQaInbound>[0]["message"]) => {
    const task = handleMessage(message)
      .catch(captureInboundError)
      .finally(() => controlTasks.delete(task));
    controlTasks.add(task);
  };
  const enqueueInbound = (message: Parameters<typeof handleQaInbound>[0]["message"]) => {
    queuedInbound = queuedInbound
      .then(() => (inboundError ? undefined : handleMessage(message)))
      .catch(captureInboundError);
  };
  try {
    while (!ctx.abortSignal.aborted) {
      if (inboundError) {
        throw inboundError;
      }
      const result = await pollQaBus({
        baseUrl: account.baseUrl,
        accountId: account.accountId,
        cursor,
        timeoutMs: account.pollTimeoutMs,
        signal: ctx.abortSignal,
      });
      cursor = result.cursor;
      for (const event of result.events) {
        if (event.kind !== "inbound-message") {
          continue;
        }
        if (event.message.nativeCommand) {
          dispatchControl(event.message);
        } else {
          enqueueInbound(event.message);
        }
      }
    }
    if (inboundError) {
      throw inboundError;
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") {
      throw error;
    }
  } finally {
    await Promise.all([queuedInbound, ...controlTasks]);
    ctx.setStatus({
      accountId: account.accountId,
      running: false,
    });
  }
  if (inboundError) {
    throw inboundError;
  }
}
