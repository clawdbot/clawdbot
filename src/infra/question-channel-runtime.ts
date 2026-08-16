// Tracks delivered native question controls until the Gateway resolves them.
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createQuestionChannelRuntime } from "./question-channel-runtime-internal.js";

const log = createSubsystemLogger("gateway/questions");
// Source-loaded plugin SDK chunks and Gateway chunks must share one delivery owner.
// Clear its pending callbacks and retention timers when the Gateway closes or restarts.
const questionChannelRuntime = resolveGlobalSingleton(
  Symbol.for("openclaw.questionChannelRuntime"),
  () =>
    createQuestionChannelRuntime({
      onFinalizeError: (error, questionId, deliveryId) => {
        log.warn(`question message finalization failed id=${questionId} delivery=${deliveryId}`, {
          error: String(error),
        });
      },
    }),
  (runtime) => runtime.clear(),
);

export const handleQuestionChannelRequested = questionChannelRuntime.handleRequested;
export const handleQuestionChannelResolved = questionChannelRuntime.handleResolved;
export const registerQuestionChannelDelivery = questionChannelRuntime.registerDelivery;
