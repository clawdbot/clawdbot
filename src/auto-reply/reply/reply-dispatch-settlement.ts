import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import type { ReplyPayloadMetadata } from "../reply-payload.js";
import {
  isExplicitlyNonVisibleDelivery,
  type ReplyDispatchDeliveryOutcome,
} from "./reply-dispatch-outcome.js";

type PendingFinalDelivery = NonNullable<ReplyPayloadMetadata["pendingFinalDeliveryCompletion"]>;
const ignoreResult = () => undefined;

function settleCustody(custody: PendingFinalDelivery | undefined, state: "delivered" | "unknown") {
  return custody
    ? settlePendingFinalDelivery({ kind: "pending-final", ...custody }, state, ["queued"])
    : undefined;
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
      void Promise.resolve(onIdle?.()).catch(ignoreResult);
    } catch {}
  };

  const schedule = <T>(run: () => Promise<T>): Promise<T> => {
    idleNotified = false;
    const delivery = sendChain.then(run);
    sendChain = delivery.then(ignoreResult, ignoreResult);
    const drained = sendChain;
    void drained.then(() => drained === sendChain && pendingFinalizations > 0 && notifyIdle());
    return delivery;
  };

  const resolve = (result: unknown, custody: PendingFinalDelivery | undefined) => {
    const finalization =
      isRecord(result) && result.finalization instanceof Promise ? result.finalization : undefined;
    pendingFinalizations += finalization ? 1 : 0;
    return {
      settlement: (async (): Promise<ReplyDispatchDeliveryOutcome> => {
        try {
          const finalized = finalization ? await finalization : undefined;
          await settleCustody(custody, "delivered");
          const outcome =
            finalization && isRecord(result) && isRecord(finalized)
              ? { ...result, ...finalized, finalization: undefined }
              : result;
          return isExplicitlyNonVisibleDelivery(outcome) ? "delivered-not-visible" : "delivered";
        } catch {
          await settleCustody(custody, "unknown");
          return "failed-deliver";
        } finally {
          pendingFinalizations -= finalization ? 1 : 0;
        }
      })(),
    };
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
      await Promise.all([sent, settled]);
    } while (sent !== sendChain || settled !== settlementChain);
  };

  return { enqueueSettlement, notifyIdle, resolve, schedule, waitForIdle };
}
