import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import type { ReplyPayloadMetadata } from "../reply-payload.js";
import {
  isExplicitlyNonVisibleDelivery,
  type ReplyDispatchDeliveryOutcome,
} from "./reply-dispatch-outcome.js";

export type ReplyDispatchDeliveryAttempt = {
  settlement: Promise<ReplyDispatchDeliveryOutcome>;
};

type FinalizationCallbacks = {
  onDelivered?: () => Promise<void>;
  onFailed?: () => Promise<void>;
};

type PendingFinalDelivery = NonNullable<ReplyPayloadMetadata["pendingFinalDeliveryCompletion"]>;

export function createPendingFinalSettlementCallbacks(
  custody: PendingFinalDelivery | undefined,
): FinalizationCallbacks | undefined {
  if (!custody) {
    return undefined;
  }
  return {
    onDelivered: async () => {
      await settlePendingFinalDelivery({ kind: "pending-final", ...custody }, "delivered", [
        "queued",
      ]);
    },
    onFailed: async () => {
      await settlePendingFinalDelivery({ kind: "pending-final", ...custody }, "unknown", [
        "queued",
      ]);
    },
  };
}

export function createReplyDispatchSettlementBarrier(onIdle?: () => unknown) {
  let sendChain: Promise<void> = Promise.resolve();
  let settlementChain: Promise<void> = Promise.resolve();
  let pendingFinalizations = 0;
  let idleNotified = false;

  const notifyIdle = () => {
    if (idleNotified) {
      return;
    }
    idleNotified = true;
    try {
      void Promise.resolve(onIdle?.()).catch(() => undefined);
    } catch {
      // Idle observers are best-effort; delivery settlement remains authoritative.
    }
  };

  const schedule = <T>(run: () => Promise<T>): Promise<T> => {
    idleNotified = false;
    const delivery = sendChain.then(run);
    sendChain = delivery.then(
      () => undefined,
      () => undefined,
    );
    const drained = sendChain;
    void drained.then(() => {
      if (drained === sendChain && pendingFinalizations > 0) {
        // Finalization producers run after send admission drains; the settlement
        // chain keeps trackers, global pending state, and receipt sealing blocked.
        notifyIdle();
      }
    });
    return delivery;
  };

  const resolve = (
    result: unknown,
    callbacks: FinalizationCallbacks = {},
  ): ReplyDispatchDeliveryAttempt => {
    const finalization =
      isRecord(result) && result.finalization instanceof Promise ? result.finalization : undefined;
    const settlement = (async (): Promise<ReplyDispatchDeliveryOutcome> => {
      if (!finalization) {
        try {
          await callbacks.onDelivered?.();
          return isExplicitlyNonVisibleDelivery(result) ? "delivered-not-visible" : "delivered";
        } catch {
          await callbacks.onFailed?.();
          return "failed-deliver";
        }
      }
      pendingFinalizations += 1;
      try {
        const finalized = await finalization;
        await callbacks.onDelivered?.();
        const outcome =
          isRecord(result) && isRecord(finalized)
            ? { ...result, ...finalized, finalization: undefined }
            : result;
        return isExplicitlyNonVisibleDelivery(outcome) ? "delivered-not-visible" : "delivered";
      } catch {
        await callbacks.onFailed?.();
        return "failed-deliver";
      } finally {
        pendingFinalizations -= 1;
      }
    })();
    return { settlement };
  };

  const enqueueSettlement = (settle: () => Promise<void>) => {
    settlementChain = settlementChain.then(settle);
  };

  const waitForIdle = async () => {
    let sent: Promise<void>;
    let settled: Promise<void>;
    do {
      sent = sendChain;
      settled = settlementChain;
      await sent;
      await settled;
    } while (sent !== sendChain || settled !== settlementChain);
  };

  return { enqueueSettlement, notifyIdle, resolve, schedule, waitForIdle };
}
