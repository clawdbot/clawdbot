import type {
  ControlModelGatewayBinding,
  ControlModelGatewayEventFrame,
} from "@openclaw/gateway-client/model/catalog";
import type { GatewayBrowserClient, GatewayEventListener } from "../api/gateway.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";

const CONTROL_MODEL_EVENT_QUEUE_LIMIT = 256;

type QueuedEvent = Readonly<{
  client: GatewayBrowserClient;
  epoch: number;
  frame: ControlModelGatewayEventFrame;
}>;

export type ControlModelGatewayBridge = Readonly<{
  binding: ControlModelGatewayBinding;
  notifyConnection(): void;
  resetLineage(): void;
  queueEvent(event: Parameters<GatewayEventListener>[0], client: GatewayBrowserClient): void;
  dispose(): void;
}>;

export function createControlModelGatewayBridge(options: {
  getGatewaySnapshot: () => {
    phase: string;
    lastError: string | null;
    lastErrorCode: string | null;
  };
  getConnectionEpoch: () => number;
  getClient: () => GatewayBrowserClient | null;
  isCurrentClient: (client: GatewayBrowserClient) => boolean;
}): ControlModelGatewayBridge {
  const connectionListeners = new Set<() => void>();
  const invalidationListeners = new Set<(_: undefined) => void>();
  const eventListeners = new Set<(frame: ControlModelGatewayEventFrame) => void>();
  let eventQueue: QueuedEvent[] = [];
  let deliveryScheduled = false;
  let lastConnectionKey = "";
  let disposed = false;
  const readConnectionSnapshot = () => {
    const gateway = options.getGatewaySnapshot();
    return {
      status:
        gateway.phase === "connected"
          ? ("connected" as const)
          : gateway.phase === "connecting"
            ? ("connecting" as const)
            : gateway.phase === "reconnecting"
              ? ("reconnecting" as const)
              : ("disconnected" as const),
      epoch: options.getConnectionEpoch(),
      ...(gateway.lastError
        ? {
            error: {
              code: gateway.lastErrorCode ?? "GATEWAY_CONNECTION",
              message: gateway.lastError,
              retryable: gateway.phase === "connecting" || gateway.phase === "reconnecting",
            },
          }
        : {}),
    };
  };

  const notifyConnection = () => {
    if (disposed) {
      return;
    }
    const connection = readConnectionSnapshot();
    const key = JSON.stringify(connection);
    if (key === lastConnectionKey) {
      return;
    }
    lastConnectionKey = key;
    // Snapshot listeners so unsubscribe/subscribe during delivery cannot change this pass.
    // oxlint-disable-next-line no-useless-spread
    for (const listener of [...connectionListeners]) {
      listener();
    }
  };

  const safelyNotify = <Value>(listeners: Set<(value: Value) => void>, value: Value) => {
    // Snapshot listeners so unsubscribe/subscribe during delivery cannot change this pass.
    // oxlint-disable-next-line no-useless-spread
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error(error);
      }
    }
  };

  const notifyEvent = (frame: ControlModelGatewayEventFrame) => {
    safelyNotify(eventListeners, frame);
    if (frame.event === "sessions.changed" || frame.event === "session.message") {
      safelyNotify(invalidationListeners, undefined);
    }
  };

  const scheduleDelivery = () => {
    if (deliveryScheduled) {
      return;
    }
    deliveryScheduled = true;
    queueMicrotask(() => {
      deliveryScheduled = false;
      const queued = eventQueue;
      eventQueue = [];
      for (const entry of queued) {
        if (
          disposed ||
          !options.isCurrentClient(entry.client) ||
          entry.epoch !== readConnectionSnapshot().epoch
        ) {
          continue;
        }
        notifyEvent(entry.frame);
      }
    });
  };

  const bridge: ControlModelGatewayBridge = {
    binding: {
      ...({
        getSessionMessageSubscriptionClient: options.getClient,
        sessionMessageKeysEquivalent: areUiSessionKeysEquivalent,
      } as object),
      getConnectionSnapshot: readConnectionSnapshot,
      subscribeConnection(listener) {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      },
      subscribeSessionCatalogInvalidations(listener) {
        invalidationListeners.add(listener);
        return () => invalidationListeners.delete(listener);
      },
      subscribeEvents(listener) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      request(method, params, requestOptions) {
        const client = options.getClient();
        if (!client || readConnectionSnapshot().status !== "connected") {
          return Promise.reject(
            Object.assign(new Error("Gateway unavailable"), {
              code: "UNAVAILABLE",
              retryable: true,
            }),
          );
        }
        return client.request(method, params, requestOptions);
      },
    },
    notifyConnection,
    resetLineage() {
      eventQueue = [];
    },
    queueEvent(event, client) {
      const epoch = readConnectionSnapshot().epoch;
      if (eventQueue.length >= CONTROL_MODEL_EVENT_QUEUE_LIMIT) {
        eventQueue = [
          {
            client,
            epoch,
            frame: {
              event: "sessions.changed",
              payload: { gap: true },
              connectionEpoch: epoch,
              gap: true,
            },
          },
        ];
      } else {
        eventQueue.push({
          client,
          epoch,
          frame: {
            event: event.event,
            payload: event.payload,
            connectionEpoch: epoch,
            seq: event.seq,
          },
        });
      }
      scheduleDelivery();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      eventQueue = [];
      connectionListeners.clear();
      invalidationListeners.clear();
      eventListeners.clear();
    },
  };
  notifyConnection();
  return bridge;
}
