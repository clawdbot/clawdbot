import type { EmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.handlers.types.js";

export function createCompactionRetryTracker(params: {
  state: EmbeddedAgentSubscribeState;
  ensureCompactionPromise: () => void;
  resolveCompactionPromiseIfIdle: () => void;
}) {
  let pendingGeneration: number | undefined;
  let replacementActivityGeneration: number | undefined;

  const noteCompactionRetry = (deliveryGeneration?: number) => {
    if (deliveryGeneration === undefined) {
      params.state.pendingCompactionRetry += 1;
    } else {
      const replacementAttemptStarted =
        pendingGeneration !== undefined && replacementActivityGeneration === pendingGeneration;
      if (
        pendingGeneration === undefined ||
        pendingGeneration === deliveryGeneration ||
        !replacementAttemptStarted
      ) {
        params.state.pendingCompactionRetry += 1;
      }
      pendingGeneration = deliveryGeneration;
      if (replacementActivityGeneration !== deliveryGeneration) {
        replacementActivityGeneration = undefined;
      }
    }
    params.ensureCompactionPromise();
  };

  const noteCompactionReplacementActivity = (deliveryGeneration: number) => {
    if (params.state.pendingCompactionRetry > 0 && deliveryGeneration === pendingGeneration) {
      replacementActivityGeneration = deliveryGeneration;
    }
  };

  const resolveCompactionRetry = (deliveryGeneration?: number) => {
    if (params.state.pendingCompactionRetry <= 0) {
      return;
    }
    if (
      deliveryGeneration !== undefined &&
      pendingGeneration !== undefined &&
      deliveryGeneration !== pendingGeneration
    ) {
      return;
    }
    params.state.pendingCompactionRetry -= 1;
    replacementActivityGeneration = undefined;
    if (params.state.pendingCompactionRetry === 0) {
      pendingGeneration = undefined;
    }
    params.resolveCompactionPromiseIfIdle();
  };

  return {
    noteCompactionReplacementActivity,
    noteCompactionRetry,
    resolveCompactionRetry,
  };
}
