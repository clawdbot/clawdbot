import { SESSION_VIEWER_PRESENCE_MAX_KEYS } from "../../../packages/gateway-protocol/src/schema/sessions-viewer-presence.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import { isGatewayMethodAdvertised } from "./gateway-methods.ts";
import { createGatewaySetSyncLifecycle } from "./gateway-set-sync-lifecycle.ts";
import { resolveSessionKey } from "./sessions/index.ts";

const SESSION_VIEWERS_SET_METHOD = "sessions.viewers.set";

type SessionViewerPresenceStore = {
  watch: (owner: object, sessionKeys: readonly string[]) => void;
  unwatch: (owner: object) => void;
};

const stores = new WeakMap<ApplicationGateway, SessionViewerPresenceStore>();

function createStore(gateway: ApplicationGateway): SessionViewerPresenceStore {
  const watchedByOwner = new Map<object, Set<string>>();
  let knownClient = gateway.snapshot.client;
  let lastHello: object | null = null;
  let lastSignature: string | null = null;
  let acknowledgedSignature: string | null = null;
  let acknowledgedGeneration = 0;
  let requestGeneration = 0;

  const isActive = () => watchedByOwner.size > 0;

  const visibleSessionKeys = (): string[] => {
    const hello = gateway.snapshot.hello;
    const keys = new Set<string>();
    for (const watched of watchedByOwner.values()) {
      for (const rawKey of watched) {
        const key = resolveSessionKey(rawKey, hello).trim();
        if (key) {
          keys.add(key);
        }
      }
    }
    return [...keys].toSorted().slice(0, SESSION_VIEWER_PRESENCE_MAX_KEYS);
  };

  const lifecycle = createGatewaySetSyncLifecycle(gateway, {
    sync,
    onAttach: () => {
      knownClient = gateway.snapshot.client;
      lastHello = null;
      lastSignature = null;
      acknowledgedSignature = null;
      acknowledgedGeneration = 0;
    },
    onDetach: () => {
      requestGeneration += 1;
      lastHello = null;
      lastSignature = null;
      acknowledgedSignature = null;
      acknowledgedGeneration = 0;
    },
  });
  const { retry } = lifecycle;

  function sync() {
    const snapshot = gateway.snapshot;
    const client = snapshot.client;
    if (client !== knownClient) {
      retry.reset();
      knownClient = client;
      lastHello = null;
      lastSignature = null;
      acknowledgedSignature = null;
      acknowledgedGeneration = 0;
    }
    const available =
      snapshot.phase === "connected" &&
      client !== null &&
      snapshot.hello !== null &&
      isGatewayMethodAdvertised(snapshot, SESSION_VIEWERS_SET_METHOD) === true;
    if (!available) {
      lastHello = null;
      lastSignature = null;
      acknowledgedSignature = null;
      acknowledgedGeneration = 0;
      if (!isActive()) {
        lifecycle.detach();
      }
      return;
    }
    const sessionKeys =
      typeof document !== "undefined" && document.visibilityState === "hidden"
        ? []
        : visibleSessionKeys();
    const agentId = sessionKeys.some((key) => !key.startsWith("agent:"))
      ? snapshot.assistantAgentId
      : undefined;
    const signature = JSON.stringify({ agentId, sessionKeys });
    if (snapshot.hello === lastHello && signature === lastSignature) {
      if (
        !isActive() &&
        acknowledgedSignature === signature &&
        acknowledgedGeneration === requestGeneration
      ) {
        lifecycle.detach();
      }
      return;
    }
    lastHello = snapshot.hello;
    lastSignature = signature;
    const currentGeneration = ++requestGeneration;
    const isCurrentRequest = () =>
      lifecycle.attached &&
      currentGeneration === requestGeneration &&
      snapshot.hello === lastHello &&
      signature === lastSignature;
    retry.cancel();
    const request = client.request(SESSION_VIEWERS_SET_METHOD, {
      ...(agentId ? { agentId } : {}),
      sessionKeys,
    });
    void request
      .then(() => {
        if (isCurrentRequest()) {
          acknowledgedSignature = signature;
          acknowledgedGeneration = currentGeneration;
          retry.reset();
          if (!isActive()) {
            lifecycle.detach();
          }
        }
      })
      .catch(() => {
        if (!isCurrentRequest()) {
          return;
        }
        lastSignature = null;
        retry.schedule(lifecycle.schedule);
      });
  }

  const watch = (owner: object, sessionKeys: readonly string[]) => {
    const next = new Set(sessionKeys.map((key) => key.trim()).filter(Boolean));
    const current = watchedByOwner.get(owner);
    const unchanged =
      current === undefined
        ? next.size === 0
        : current.size === next.size && [...next].every((key) => current.has(key));
    if (unchanged) {
      return;
    }
    if (next.size === 0) {
      watchedByOwner.delete(owner);
    } else {
      watchedByOwner.set(owner, next);
    }
    retry.reset();
    if (isActive()) {
      lifecycle.attach();
      lifecycle.schedule();
    } else if (lifecycle.attached) {
      lifecycle.sync();
    }
  };

  return { watch, unwatch: (owner) => watch(owner, []) };
}

export function sessionViewerPresenceForGateway(
  gateway: ApplicationGateway,
): SessionViewerPresenceStore {
  const existing = stores.get(gateway);
  if (existing) {
    return existing;
  }
  const store = createStore(gateway);
  stores.set(gateway, store);
  return store;
}
