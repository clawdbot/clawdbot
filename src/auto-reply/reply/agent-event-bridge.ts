// Generic agent-event bridge machinery shared by the CLI runner's per-stream
// delivery bridges (assistant, reasoning, commentary, plan).
import { type AgentEventPayload, onAgentEvent } from "../../infra/agent-events.js";

export type AgentEventDeliveryStartOrder = {
  schedule: (deliver: () => Promise<void>) => Promise<void>;
};

export function createAgentEventDeliveryStartOrder(): AgentEventDeliveryStartOrder {
  let startTail = Promise.resolve();
  return {
    schedule: async (deliver) => {
      // Reserve at raw event receipt, then release at callback invocation. CLI streams drain
      // independently, so waiting for callback completion here would reorder later streams.
      const previousStart = startTail;
      let releaseStart: (() => void) | undefined;
      startTail = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      await previousStart;
      let delivery: Promise<void>;
      try {
        delivery = deliver();
      } finally {
        releaseStart?.();
      }
      await delivery;
    },
  };
}

export function createAgentEventBridge<T>(params: {
  runId: string;
  suppressed?: boolean;
  read: (evt: AgentEventPayload) => T | undefined;
  deliver?: (payload: T) => Promise<void>;
  startOrder?: AgentEventDeliveryStartOrder;
}) {
  const deliver = params.deliver;
  if (!deliver) {
    return {
      unsubscribe: () => undefined,
      drain: async (): Promise<void> => undefined,
    };
  }
  let unsubscribed = false;
  let delivery = Promise.resolve();
  const rawUnsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== params.runId) {
      return;
    }
    if (params.suppressed) {
      return;
    }
    const payload = params.read(evt);
    if (payload === undefined) {
      return;
    }
    if (!params.startOrder) {
      delivery = delivery.then(() => deliver(payload)).catch(() => undefined);
      return;
    }
    const scheduled = params.startOrder.schedule(() => deliver(payload)).catch(() => undefined);
    // Start ordering stays global; each bridge still owns and drains its callback completion.
    delivery = Promise.all([delivery, scheduled]).then(() => undefined);
  });
  return {
    unsubscribe() {
      if (unsubscribed) {
        return;
      }
      unsubscribed = true;
      rawUnsubscribe();
    },
    async drain(): Promise<void> {
      await delivery;
    },
  };
}
