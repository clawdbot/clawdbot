import type { ApplicationGateway } from "../app/gateway.ts";
import { createGatewayRetryOwner } from "./gateway-retry.ts";

/** Active consumers own registrations and fence queued work when their set detaches. */
export function createGatewaySetSyncLifecycle(
  gateway: ApplicationGateway,
  options: {
    sync: () => void;
    onAttach: () => void;
    onDetach: () => void;
    onSnapshot?: Parameters<ApplicationGateway["subscribe"]>[0];
    onEvent?: Parameters<ApplicationGateway["subscribeEvents"]>[0];
  },
) {
  const retry = createGatewayRetryOwner();
  let attached = false;
  let scheduled = false;
  let scheduleGeneration = 0;
  let stopSnapshots: (() => void) | null = null;
  let stopEvents: (() => void) | null = null;
  let visibilityDocument: Document | null = null;

  function sync() {
    scheduled = false;
    if (attached) {
      options.sync();
    }
  }

  function schedule() {
    if (!attached || scheduled) {
      return;
    }
    scheduled = true;
    const generation = scheduleGeneration;
    globalThis.queueMicrotask(() => {
      if (generation === scheduleGeneration) {
        sync();
      }
    });
  }

  const handleVisibilityChange = () => {
    retry.reset();
    schedule();
  };

  return {
    get attached() {
      return attached;
    },
    get retry() {
      return retry;
    },
    sync,
    schedule,
    attach() {
      if (attached) {
        return;
      }
      attached = true;
      options.onAttach();
      stopSnapshots = gateway.subscribe(options.onSnapshot ?? schedule);
      stopEvents = options.onEvent ? gateway.subscribeEvents(options.onEvent) : null;
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", handleVisibilityChange);
        visibilityDocument = document;
      }
    },
    detach() {
      if (!attached) {
        return;
      }
      attached = false;
      stopSnapshots?.();
      stopSnapshots = null;
      stopEvents?.();
      stopEvents = null;
      visibilityDocument?.removeEventListener("visibilitychange", handleVisibilityChange);
      visibilityDocument = null;
      retry.reset();
      scheduleGeneration += 1;
      scheduled = false;
      options.onDetach();
    },
  };
}
