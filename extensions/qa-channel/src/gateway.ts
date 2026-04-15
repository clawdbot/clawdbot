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
  try {
    while (!ctx.abortSignal.aborted) {
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
        await handleQaInbound({
          channelId,
          channelLabel,
          account,
          config: ctx.cfg as CoreConfig,
          message: event.message,
        });
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") {
      throw error;
    }
  }
  ctx.setStatus({
    accountId: account.accountId,
    running: false,
  });
}
