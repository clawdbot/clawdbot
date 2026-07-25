// Tracks delivered native question controls until the Gateway resolves them.
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createQuestionChannelRuntime } from "./question-channel-runtime-internal.js";

const log = createSubsystemLogger("gateway/questions");
const questionChannelRuntime = createQuestionChannelRuntime({
  onFinalizeError: (error, questionId, deliveryId) => {
    log.warn(`question message finalization failed id=${questionId} delivery=${deliveryId}`, {
      error: String(error),
    });
  },
});

export const handleQuestionChannelRequested = questionChannelRuntime.handleRequested;
export const handleQuestionChannelResolved = questionChannelRuntime.handleResolved;
export const registerQuestionChannelDelivery = questionChannelRuntime.registerDelivery;
