// QQBot plugin module fans one merged turn lifecycle across its durable claims.
import type { QQBotIngressLifecycle } from "./types.js";

async function settleAll(
  lifecycles: readonly QQBotIngressLifecycle[],
  label: string,
  settle: (lifecycle: QQBotIngressLifecycle) => void | Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(
    lifecycles.map(async (lifecycle) => await settle(lifecycle)),
  );
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, `QQBot merged ingress ${label} failed.`);
  }
}

function notifyAll(
  lifecycles: readonly QQBotIngressLifecycle[],
  label: string,
  notify: (lifecycle: QQBotIngressLifecycle) => void,
): void {
  const errors: unknown[] = [];
  for (const lifecycle of lifecycles) {
    try {
      notify(lifecycle);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, `QQBot merged ingress ${label} failed.`);
  }
}

export function buildQQBotMergedIngressLifecycle(
  messages: readonly { turnAdoptionLifecycle?: QQBotIngressLifecycle }[],
): QQBotIngressLifecycle | undefined {
  const lifecycles = messages
    .map((message) => message.turnAdoptionLifecycle)
    .filter((lifecycle) => lifecycle !== undefined);
  const [firstLifecycle] = lifecycles;
  if (!firstLifecycle) {
    return undefined;
  }
  if (lifecycles.length === 1) {
    return firstLifecycle;
  }
  return {
    abortSignal: AbortSignal.any(lifecycles.map((lifecycle) => lifecycle.abortSignal)),
    onAdopted: () => settleAll(lifecycles, "adoption", (lifecycle) => lifecycle.onAdopted()),
    onDeferred: () => {
      notifyAll(lifecycles, "deferral", (lifecycle) => lifecycle.onDeferred());
    },
    onAdoptionFinalizing: () => {
      notifyAll(lifecycles, "adoption finalization", (lifecycle) =>
        lifecycle.onAdoptionFinalizing(),
      );
    },
    onAbandoned: () => settleAll(lifecycles, "abandonment", (lifecycle) => lifecycle.onAbandoned()),
  };
}
