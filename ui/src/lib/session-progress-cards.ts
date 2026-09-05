import {
  GATEWAY_SERVER_CAPS,
  type ProgressCard,
  type ProgressCardGetParams,
  type ProgressCardGetResult,
  type ProgressCardPutResult,
  type ProgressCardStep,
} from "@openclaw/gateway-protocol";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError } from "../api/gateway.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { createGatewayConnectionLifecycle } from "./gateway-connection-lifecycle.ts";
import { isGatewayCapabilityAdvertised, isGatewayMethodAdvertised } from "./gateway-methods.ts";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConversationIdentity,
  scopedSessionArtifactKey,
  type UiSessionDefaultsHost,
} from "./sessions/session-key.ts";

const PROGRESS_CARD_GET_METHOD = "progressCard.get";
const PROGRESS_CARD_PUT_METHOD = "progressCard.put";
const PROGRESS_CARD_CHANGED_EVENT = "progressCard.changed";
const CACHE_LIMIT = 100;

type ProgressCardEntry = {
  target: ProgressCardGetParams;
  wireKey: string;
  generation: number;
  dirty: boolean;
  card?: ProgressCard | null;
  error?: SessionProgressCardLoadError;
  load?: Promise<ProgressCard | null>;
};

type SessionProgressCardLoadError = "access-denied" | "unavailable" | "unsupported-owner";

export type SessionProgressCardStore = {
  watch: (owner: object, targets: readonly ProgressCardGetParams[]) => void;
  unwatch: (owner: object) => void;
  load: (target: ProgressCardGetParams) => Promise<ProgressCard | null>;
  dismiss: (target: ProgressCardGetParams, card: ProgressCard) => Promise<boolean>;
  get: (target: ProgressCardGetParams) => ProgressCard | null | undefined;
  getError: (target: ProgressCardGetParams) => SessionProgressCardLoadError | undefined;
  subscribe: (listener: () => void) => () => void;
};

const stores = new WeakMap<ApplicationGateway, SessionProgressCardStore>();

function parseProgressCardStep(value: unknown): ProgressCardStep | null {
  if (!isRecord(value) || typeof value.step !== "string") {
    return null;
  }
  if (
    value.status !== "pending" &&
    value.status !== "in_progress" &&
    value.status !== "completed"
  ) {
    return null;
  }
  return { status: value.status, step: value.step };
}

function parseProgressCard(value: unknown, sessionKey: string): ProgressCard | null {
  if (!isRecord(value)) {
    throw new Error("Progress card response was invalid");
  }
  const card = value.card;
  if (card === null) {
    return null;
  }
  if (!isRecord(card)) {
    throw new Error("Progress card response was invalid");
  }
  const markdown = card.markdown;
  const revision = card.revision;
  const updatedAt = asDateTimestampMs(card.updatedAt);
  const rawSteps = card.steps;
  if (
    card.sessionKey !== sessionKey ||
    (markdown !== undefined && typeof markdown !== "string") ||
    (rawSteps !== undefined && !Array.isArray(rawSteps)) ||
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    updatedAt === undefined ||
    !Number.isInteger(updatedAt)
  ) {
    throw new Error("Progress card response did not match the requested session");
  }
  const steps = Array.isArray(rawSteps) ? rawSteps.map(parseProgressCardStep) : undefined;
  if (steps?.some((step) => step === null)) {
    throw new Error("Progress card response contained invalid steps");
  }
  const parsedSteps = steps?.filter((step) => step !== null);
  if (markdown === undefined && (!parsedSteps || parsedSteps.length === 0)) {
    throw new Error("Progress card response contained no content");
  }
  return {
    sessionKey,
    revision,
    updatedAt,
    ...(markdown !== undefined ? { markdown } : {}),
    ...(parsedSteps && parsedSteps.length > 0 ? { steps: parsedSteps } : {}),
  };
}

// Progress follows store routing: sentinels stay bare; other keys use the captured
// owner, which generic UI identity otherwise drops for ordinary bare keys.
export function resolveSessionProgressCardTarget(
  host: UiSessionDefaultsHost,
  target: ProgressCardGetParams,
): ProgressCardGetParams {
  const agentId = target.agentId?.trim() ? normalizeAgentId(target.agentId) : undefined;
  const key = target.sessionKey.trim();
  const sentinel = key.toLowerCase();
  return {
    ...(agentId ? { agentId } : {}),
    ...resolveUiConversationIdentity(
      host,
      sentinel === "global" || sentinel === "unknown"
        ? sentinel
        : scopedSessionArtifactKey(key, agentId),
      agentId,
    ),
  };
}

function createStore(gateway: ApplicationGateway): SessionProgressCardStore {
  const watchedByOwner = new Map<object, readonly ProgressCardGetParams[]>();
  const entries = new Map<string, ProgressCardEntry>();
  const listeners = new Set<() => void>();
  const connection = createGatewayConnectionLifecycle(gateway.snapshot);
  let knownClient = gateway.snapshot.client;
  let knownAvailable = false;
  let stopGatewaySnapshots: (() => void) | null = null;
  let stopGatewayEvents: (() => void) | null = null;

  const resolveTarget = (target: ProgressCardGetParams) => {
    const canonical = resolveSessionProgressCardTarget(gateway.snapshot, target);
    return {
      target: canonical,
      key: JSON.stringify([canonical.agentId ?? null, canonical.sessionKey]),
      wireKey: scopedSessionArtifactKey(canonical.sessionKey, canonical.agentId),
    };
  };
  const watchedTargets = () =>
    new Map(
      Array.from(watchedByOwner.values()).flatMap((targets) =>
        targets.map((target) => {
          const resolved = resolveTarget(target);
          return [resolved.key, resolved.target] as const;
        }),
      ),
    );
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const recordRequestError = (entry: ProgressCardEntry, error: unknown) => {
    const accessDenied =
      error instanceof GatewayRequestError &&
      isRecord(error.details) &&
      error.details.code === "SESSION_PARTICIPATION_REQUIRED";
    entry.error = accessDenied ? "access-denied" : "unavailable";
    entry.dirty = true;
    if (accessDenied) {
      entry.card = null;
    }
    notify();
  };
  const remember = (key: string, entry: ProgressCardEntry) => {
    entries.delete(key);
    entries.set(key, entry);
    const watched = watchedTargets();
    while (entries.size > CACHE_LIMIT) {
      const oldest = [...entries].find(
        ([candidate, value]) => !watched.has(candidate) && !value.load,
      );
      if (!oldest) {
        break;
      }
      entries.delete(oldest[0]);
    }
  };
  const available = () =>
    gateway.snapshot.phase === "connected" &&
    gateway.snapshot.client !== null &&
    isGatewayMethodAdvertised(gateway.snapshot, PROGRESS_CARD_GET_METHOD) === true;

  const requestTarget = (entry: ProgressCardEntry): ProgressCardGetParams => {
    if (parseAgentSessionKey(entry.target.sessionKey)) {
      // Qualified keys already carry their owner; older schemas reject redundant fields.
      return { sessionKey: entry.target.sessionKey };
    }
    if (
      entry.target.agentId &&
      isGatewayCapabilityAdvertised(
        gateway.snapshot,
        GATEWAY_SERVER_CAPS.PROGRESS_CARD_AGENT_SCOPE,
      ) === true
    ) {
      return entry.target;
    }
    // Old gateways cannot address canonical global by owner, even through a main alias.
    entry.error = "unsupported-owner";
    notify();
    throw new Error("Update the Gateway to view progress for this session's agent.");
  };

  const load = async (target: ProgressCardGetParams): Promise<ProgressCard | null> => {
    const resolved = resolveTarget(target);
    if (!resolved.target.sessionKey || !available()) {
      return null;
    }
    const entry: ProgressCardEntry = entries.get(resolved.key) ?? {
      target: resolved.target,
      wireKey: resolved.wireKey,
      generation: 0,
      dirty: true,
    };
    remember(resolved.key, entry);
    const params = requestTarget(entry);
    if (!entry.dirty && entry.card !== undefined) {
      return entry.card;
    }
    if (entry.load) {
      return entry.load;
    }
    connection.transition(gateway.snapshot);
    const scope = connection.capture();
    if (!scope) {
      return null;
    }
    const generation = entry.generation;
    const current = () =>
      entries.get(resolved.key) === entry &&
      entry.generation === generation &&
      connection.isCurrent(scope) &&
      gateway.snapshot.client === scope.client;
    const request = scope.client
      .request<ProgressCardGetResult>(PROGRESS_CARD_GET_METHOD, params)
      .then((response) => {
        const card = parseProgressCard(response, entry.wireKey);
        if (!current()) {
          return null;
        }
        entry.card = card;
        entry.dirty = false;
        delete entry.error;
        notify();
        return card;
      })
      .catch((error: unknown) => {
        if (current()) {
          recordRequestError(entry, error);
        }
        throw error;
      })
      .finally(() => {
        if (entry.load === request) {
          delete entry.load;
          if (entries.get(resolved.key) === entry) {
            remember(resolved.key, entry);
          }
        }
      });
    entry.load = request;
    remember(resolved.key, entry);
    return request;
  };
  const refreshWatched = () => {
    for (const target of watchedTargets().values()) {
      void load(target).catch(() => undefined);
    }
  };
  const handleGatewaySnapshot = (snapshot: ApplicationGateway["snapshot"]) => {
    connection.transition(snapshot);
    const clientChanged = snapshot.client !== knownClient;
    const nextAvailable = available();
    const becameAvailable = nextAvailable && !knownAvailable;
    if (!nextAvailable && knownAvailable) {
      // Automatic reconnect reuses the client. Retire its reads, but retain presentation.
      for (const entry of entries.values()) {
        entry.dirty = true;
        delete entry.load;
      }
    }
    knownAvailable = nextAvailable;
    if (!clientChanged && !becameAvailable) {
      return;
    }
    if (clientChanged) {
      knownClient = snapshot.client;
      entries.clear();
      notify();
    }
    refreshWatched();
  };
  const handleGatewayEvent: Parameters<ApplicationGateway["subscribeEvents"]>[0] = (event) => {
    if (event.event !== PROGRESS_CARD_CHANGED_EVENT || !isRecord(event.payload)) {
      return;
    }
    const { sessionKey, revision } = event.payload;
    if (
      typeof sessionKey !== "string" ||
      (revision !== null && (typeof revision !== "number" || !Number.isInteger(revision)))
    ) {
      return;
    }
    const watched = watchedTargets();
    // Loading rewrites LRU order, so capture the matching entries before starting requests.
    const matching = [...entries].filter(([, entry]) => entry.wireKey === sessionKey);
    for (const [key, entry] of matching) {
      // Distinct canonical rows can share a wire key. Even a null revision is
      // only a refresh hint; the captured owner request alone may clear a card.
      entry.generation += 1;
      entry.dirty = true;
      delete entry.error;
      if (watched.has(key)) {
        const refresh = () => {
          if (watchedTargets().has(key)) {
            void load(entry.target).catch(() => undefined);
          }
        };
        if (entry.load) {
          void entry.load.finally(refresh).catch(() => undefined);
        } else {
          refresh();
        }
      }
    }
  };
  const attach = () => {
    if (stopGatewaySnapshots || stopGatewayEvents) {
      return;
    }
    connection.transition(gateway.snapshot);
    knownAvailable = available();
    stopGatewaySnapshots = gateway.subscribe(handleGatewaySnapshot);
    stopGatewayEvents = gateway.subscribeEvents(handleGatewayEvent);
  };
  const detachIfIdle = () => {
    if (watchedByOwner.size > 0 || listeners.size > 0) {
      return;
    }
    stopGatewaySnapshots?.();
    stopGatewayEvents?.();
    stopGatewaySnapshots = null;
    stopGatewayEvents = null;
    // Without event/client subscriptions these snapshots cannot remain fresh.
    entries.clear();
  };
  const watch = (owner: object, targets: readonly ProgressCardGetParams[]) => {
    // Retain aliases so a replacement Gateway can resolve its new routing facts.
    const retained = targets
      .filter((target) => target.sessionKey.trim())
      .map(({ sessionKey, agentId }) => ({ sessionKey, agentId }));
    if (retained.length === 0) {
      watchedByOwner.delete(owner);
      detachIfIdle();
      return;
    }
    watchedByOwner.set(owner, retained);
    attach();
    for (const target of retained) {
      void load(target).catch(() => undefined);
    }
  };
  return {
    watch,
    unwatch: (owner) => watch(owner, []),
    load,
    dismiss: async (target, card) => {
      connection.transition(gateway.snapshot);
      const scope = connection.capture();
      if (!scope) {
        return false;
      }
      const resolved = resolveTarget(target);
      const entry = entries.get(resolved.key);
      if (!entry || entry.card !== card) {
        return false;
      }
      const generation = entry.generation;
      const current = () =>
        entries.get(resolved.key) === entry &&
        connection.isCurrent(scope) &&
        gateway.snapshot.client === scope.client;
      const result = await scope.client
        .request<ProgressCardPutResult>(PROGRESS_CARD_PUT_METHOD, {
          ...requestTarget(entry),
          expectedRevision: card.revision,
        })
        .catch((error: unknown) => {
          if (current() && entry.generation === generation) {
            recordRequestError(entry, error);
          }
          throw error;
        });
      const resultCard = parseProgressCard(result, entry.wireKey);
      if (!current()) {
        return false;
      }
      const dismissed = resultCard === null;
      // Its own invalidation may precede the reply; a clear still owns the captured revision.
      if (resultCard ? entry.generation === generation : entry.card?.revision === card.revision) {
        entry.card = resultCard;
        entry.dirty = false;
        delete entry.error;
        remember(resolved.key, entry);
        notify();
      }
      return dismissed;
    },
    get: (target) => entries.get(resolveTarget(target).key)?.card,
    getError: (target) => entries.get(resolveTarget(target).key)?.error,
    subscribe: (listener) => {
      listeners.add(listener);
      attach();
      return () => {
        listeners.delete(listener);
        detachIfIdle();
      };
    },
  };
}

export function sessionProgressCardsForGateway(
  gateway: ApplicationGateway,
): SessionProgressCardStore {
  const existing = stores.get(gateway);
  if (existing) {
    return existing;
  }
  const store = createStore(gateway);
  stores.set(gateway, store);
  return store;
}
