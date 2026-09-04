import type {
  ProgressCard,
  ProgressCardGetResult,
  ProgressCardPutResult,
  ProgressCardStep,
} from "@openclaw/gateway-protocol";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError } from "../api/gateway.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { isGatewayMethodAdvertised } from "./gateway-methods.ts";

const PROGRESS_CARD_GET_METHOD = "progressCard.get";
const PROGRESS_CARD_PUT_METHOD = "progressCard.put";
const PROGRESS_CARD_CHANGED_EVENT = "progressCard.changed";
const CACHE_LIMIT = 100;

type CachedProgressCard = {
  card: ProgressCard | null;
  revision: number | null;
};

type SessionProgressCardLoadError = "access-denied" | "unavailable";

export type SessionProgressCardStore = {
  watch: (owner: object, sessionKeys: readonly string[]) => void;
  unwatch: (owner: object) => void;
  load: (sessionKey: string) => Promise<ProgressCard | null>;
  dismiss: (card: ProgressCard) => Promise<boolean>;
  get: (sessionKey: string) => ProgressCard | null | undefined;
  getError: (sessionKey: string) => SessionProgressCardLoadError | undefined;
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

function createStore(gateway: ApplicationGateway): SessionProgressCardStore {
  const watchedByOwner = new Map<object, Set<string>>();
  const cache = new Map<string, CachedProgressCard>();
  const errors = new Map<string, SessionProgressCardLoadError>();
  const loads = new Map<string, Promise<ProgressCard | null>>();
  const loadGenerations = new Map<string, number>();
  const listeners = new Set<() => void>();
  let knownClient = gateway.snapshot.client;
  let knownAvailable = false;
  let stopGatewaySnapshots: (() => void) | null = null;
  let stopGatewayEvents: (() => void) | null = null;

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const watchedKeys = () =>
    new Set(Array.from(watchedByOwner.values()).flatMap((keys) => Array.from(keys)));

  const remember = (sessionKey: string, cached: CachedProgressCard) => {
    cache.delete(sessionKey);
    cache.set(sessionKey, cached);
    while (cache.size > CACHE_LIMIT) {
      const watched = watchedKeys();
      const oldest = [...cache.keys()].find((key) => !watched.has(key));
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
  };

  const available = () =>
    gateway.snapshot.phase === "connected" &&
    gateway.snapshot.client !== null &&
    isGatewayMethodAdvertised(gateway.snapshot, PROGRESS_CARD_GET_METHOD) === true;

  const load = async (sessionKeyValue: string): Promise<ProgressCard | null> => {
    const sessionKey = sessionKeyValue.trim();
    if (!sessionKey || !available()) {
      return null;
    }
    const cached = cache.get(sessionKey);
    if (cached) {
      remember(sessionKey, cached);
      return cached.card;
    }
    const active = loads.get(sessionKey);
    if (active) {
      return active;
    }
    const client = gateway.snapshot.client;
    if (!client) {
      return null;
    }
    if (errors.delete(sessionKey)) {
      notify();
    }
    const generation = loadGenerations.get(sessionKey) ?? 0;
    const clientAtRequest = client;
    const request = client
      .request<ProgressCardGetResult>(PROGRESS_CARD_GET_METHOD, { sessionKey })
      .then((response) => {
        const card = parseProgressCard(response, sessionKey);
        if (
          (loadGenerations.get(sessionKey) ?? 0) !== generation ||
          gateway.snapshot.client !== clientAtRequest
        ) {
          return null;
        }
        remember(sessionKey, { card, revision: card?.revision ?? null });
        notify();
        return card;
      })
      .catch((error: unknown) => {
        if (
          (loadGenerations.get(sessionKey) ?? 0) === generation &&
          gateway.snapshot.client === clientAtRequest
        ) {
          const accessDenied =
            error instanceof GatewayRequestError &&
            isRecord(error.details) &&
            error.details.code === "SESSION_PARTICIPATION_REQUIRED";
          errors.set(sessionKey, accessDenied ? "access-denied" : "unavailable");
          notify();
        }
        throw error;
      })
      .finally(() => {
        if (loads.get(sessionKey) === request) {
          loads.delete(sessionKey);
        }
      });
    loads.set(sessionKey, request);
    return request;
  };

  const refreshWatched = () => {
    for (const sessionKey of watchedKeys()) {
      void load(sessionKey).catch(() => undefined);
    }
  };

  const handleGatewaySnapshot = (snapshot: ApplicationGateway["snapshot"]) => {
    const clientChanged = snapshot.client !== knownClient;
    const nextAvailable = available();
    const becameAvailable = nextAvailable && !knownAvailable;
    knownAvailable = nextAvailable;
    if (!clientChanged && !becameAvailable) {
      return;
    }
    if (clientChanged) {
      knownClient = snapshot.client;
      for (const sessionKey of loads.keys()) {
        loadGenerations.set(sessionKey, (loadGenerations.get(sessionKey) ?? 0) + 1);
      }
      cache.clear();
      errors.clear();
      loads.clear();
      notify();
    }
    refreshWatched();
  };

  const handleGatewayEvent: Parameters<ApplicationGateway["subscribeEvents"]>[0] = (event) => {
    if (event.event !== PROGRESS_CARD_CHANGED_EVENT || !isRecord(event.payload)) {
      return;
    }
    const sessionKey = event.payload.sessionKey;
    const revision = event.payload.revision;
    if (
      typeof sessionKey !== "string" ||
      (revision !== null && (typeof revision !== "number" || !Number.isInteger(revision)))
    ) {
      return;
    }
    if (cache.get(sessionKey)?.revision === revision) {
      return;
    }
    if (revision === null) {
      loadGenerations.set(sessionKey, (loadGenerations.get(sessionKey) ?? 0) + 1);
      errors.delete(sessionKey);
      remember(sessionKey, { card: null, revision: null });
      notify();
      return;
    }
    loadGenerations.set(sessionKey, (loadGenerations.get(sessionKey) ?? 0) + 1);
    cache.delete(sessionKey);
    errors.delete(sessionKey);
    if (watchedKeys().has(sessionKey)) {
      const active = loads.get(sessionKey);
      if (active) {
        void active
          .finally(() => void load(sessionKey).catch(() => undefined))
          .catch(() => undefined);
      } else {
        void load(sessionKey).catch(() => undefined);
      }
    }
  };

  const attach = () => {
    if (stopGatewaySnapshots || stopGatewayEvents) {
      return;
    }
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
    loads.clear();
  };

  const watch = (owner: object, sessionKeys: readonly string[]) => {
    const keys = new Set(sessionKeys.map((key) => key.trim()).filter(Boolean));
    if (keys.size === 0) {
      watchedByOwner.delete(owner);
      detachIfIdle();
      return;
    }
    watchedByOwner.set(owner, keys);
    attach();
    for (const sessionKey of keys) {
      void load(sessionKey).catch(() => undefined);
    }
  };

  return {
    watch,
    unwatch: (owner) => watch(owner, []),
    load,
    dismiss: async (card) => {
      const client = gateway.snapshot.client;
      if (!client) {
        return false;
      }
      const result = await client.request<ProgressCardPutResult>(PROGRESS_CARD_PUT_METHOD, {
        sessionKey: card.sessionKey,
        expectedRevision: card.revision,
      });
      const resultCard = parseProgressCard(result, card.sessionKey);
      const dismissed = resultCard === null;
      if (dismissed && cache.get(card.sessionKey)?.revision === card.revision) {
        remember(card.sessionKey, { card: null, revision: null });
        notify();
      } else if (resultCard) {
        remember(card.sessionKey, { card: resultCard, revision: resultCard.revision });
        notify();
      }
      return dismissed;
    },
    get: (sessionKey) => cache.get(sessionKey)?.card,
    getError: (sessionKey) => errors.get(sessionKey),
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
