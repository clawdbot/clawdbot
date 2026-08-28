import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import type { matrixChannelRuntime } from "./channel.runtime.js";

export function createMatrixMessageAdapter(params: {
  outbound: ChannelOutboundAdapter;
  getRuntime: () => Promise<typeof matrixChannelRuntime>;
}) {
  const base = createChannelMessageAdapterFromOutbound({
    id: "matrix",
    outbound: params.outbound,
    live: {
      capabilities: {
        draftPreview: true,
        previewFinalization: true,
        progressUpdates: true,
        quietFinalization: true,
      },
      finalizer: {
        capabilities: {
          finalEdit: true,
          normalFallback: true,
          discardPending: true,
          previewReceipt: true,
        },
      },
    },
  });

  return {
    ...base,
    durableFinal: {
      ...base.durableFinal,
      automaticUnknownSendReconciliation: true,
      capabilities: {
        ...base.durableFinal?.capabilities,
        afterCommit: true,
        reconcileUnknownSend: true,
      },
      reconcileUnknownSendKinds: { text: true, media: true },
      reconcileUnknownSend: async (ctx) =>
        await (await params.getRuntime()).reconcileMatrixUnknownSend(ctx),
      afterUnknownSendTerminal: async (ctx) =>
        await (await params.getRuntime()).cleanupMatrixDeliveryPlans({ queueId: ctx.queueId }),
    },
    send: {
      ...base.send,
      lifecycle: {
        afterCommit: async (ctx) => {
          if (!ctx.deliveryQueueId) {
            return;
          }
          await (
            await params.getRuntime()
          ).cleanupMatrixDeliveryPlans({
            queueId: ctx.deliveryQueueId,
          });
        },
      },
    },
  } satisfies typeof base;
}
