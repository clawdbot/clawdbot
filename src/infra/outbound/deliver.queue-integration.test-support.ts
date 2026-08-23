import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { drainPendingDeliveriesCore, type DeliverFn } from "./delivery-queue.js";
import { createRecoveryLog } from "./delivery-queue.test-helpers.js";

export const boundedCronCompletionRetention = {
  idPrefix: "cron-direct-delivery:v1:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const;

type MatrixSendFn = (
  to: string,
  text: string,
  options?: Record<string, unknown>,
) => Promise<{ messageId: string } & Record<string, unknown>>;

function resolveMatrixSender(
  deps: Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0]["deps"],
): MatrixSendFn {
  const sender = deps?.matrix;
  if (typeof sender !== "function") {
    throw new Error("missing matrix sender");
  }
  return sender as MatrixSendFn;
}

function withMatrixChannel(result: Awaited<ReturnType<MatrixSendFn>>) {
  return {
    channel: "matrix" as const,
    ...result,
  };
}

export const matrixOutboundForQueueTest: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ cfg, to, text, accountId, deps }) =>
    withMatrixChannel(
      await resolveMatrixSender(deps)(to, text, {
        cfg,
        accountId: accountId ?? undefined,
      }),
    ),
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps }) =>
    withMatrixChannel(
      await resolveMatrixSender(deps)(to, text ?? "", {
        cfg,
        accountId: accountId ?? undefined,
        mediaUrl,
      }),
    ),
};

export async function drainMatrixReconnect(opts: {
  deliver: DeliverFn;
  stateDir: string;
}): Promise<void> {
  await drainPendingDeliveriesCore({
    drainKey: "matrix:reconnect-test",
    logLabel: "Matrix reconnect drain",
    cfg: {} as OpenClawConfig,
    log: createRecoveryLog(),
    stateDir: opts.stateDir,
    deliver: opts.deliver,
    selectEntry: (entry) => ({ match: entry.channel === "matrix", bypassBackoff: true }),
  });
}
