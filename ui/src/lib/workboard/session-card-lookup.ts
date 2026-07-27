import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { normalizeSessionKeyForUiComparison } from "../sessions/session-key.ts";
import { normalizeCardsPayload } from "./normalization.ts";
import { WORKBOARD_CHANGED_EVENT, type WorkboardCard, type WorkboardStatus } from "./types.ts";

type WorkboardLookupClient = Pick<GatewayBrowserClient, "request" | "addEventListener">;
const WORKBOARD_SESSION_RUN_LOOKUP_LIMIT = 16;

export type WorkboardSessionCardMatch = {
  cardId: string;
  title: string;
  status: WorkboardStatus;
  boardId: string;
};

type WorkboardSessionCardListener = (match: WorkboardSessionCardMatch | null) => void;

type WorkboardLookupSnapshot = {
  matches: Map<string, WorkboardSessionCardMatch>;
  runCandidates: WorkboardCard[];
};

function normalizeLookupSessionKey(sessionKey: string): string {
  return normalizeSessionKeyForUiComparison(sessionKey.trim());
}

function cardSessionKeys(card: WorkboardCard): string[] {
  return [
    card.sessionKey,
    card.execution?.sessionKey,
    ...(card.metadata?.attempts?.map((attempt) => attempt.sessionKey) ?? []),
    ...(card.events?.map((event) => event.sessionKey) ?? []),
  ]
    .filter((sessionKey): sessionKey is string => typeof sessionKey === "string")
    .map(normalizeLookupSessionKey)
    .filter(Boolean);
}

function cardMatch(card: WorkboardCard): WorkboardSessionCardMatch {
  return {
    cardId: card.id,
    title: card.title,
    status: card.status,
    boardId: card.metadata?.automation?.boardId?.trim() || "default",
  };
}

function indexCards(cards: readonly WorkboardCard[]): Map<string, WorkboardSessionCardMatch> {
  const matches = new Map<string, WorkboardSessionCardMatch>();
  for (const card of cards.toSorted((left, right) => right.updatedAt - left.updatedAt)) {
    const match = cardMatch(card);
    for (const sessionKey of cardSessionKeys(card)) {
      if (!matches.has(sessionKey)) {
        matches.set(sessionKey, match);
      }
    }
  }
  return matches;
}

function runSessionKeys(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || !("attempts" in payload)) {
    return [];
  }
  const attempts = (payload as { attempts?: unknown }).attempts;
  if (!Array.isArray(attempts)) {
    return [];
  }
  return attempts.flatMap((attempt) => {
    if (!attempt || typeof attempt !== "object" || !("sessionKey" in attempt)) {
      return [];
    }
    const sessionKey = (attempt as { sessionKey?: unknown }).sessionKey;
    return typeof sessionKey === "string" ? [normalizeLookupSessionKey(sessionKey)] : [];
  });
}

class WorkboardSessionCardLookup {
  private readonly listeners = new Map<string, Set<WorkboardSessionCardListener>>();
  private readonly unsubscribeGateway: () => void;
  private matches = new Map<string, WorkboardSessionCardMatch>();
  private refreshPromise: Promise<void> | undefined;
  private runCandidates: WorkboardCard[] = [];
  private runCandidateIndex = 0;
  private runScanPromise: Promise<void> | undefined;
  private generation = 0;
  private loaded = false;

  constructor(private readonly client: WorkboardLookupClient) {
    this.unsubscribeGateway = client.addEventListener((event) => {
      if (event.event === WORKBOARD_CHANGED_EVENT) {
        this.invalidate();
      }
    });
  }

  subscribe(sessionKey: string, listener: WorkboardSessionCardListener): () => void {
    const key = normalizeLookupSessionKey(sessionKey);
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(key, listeners);
    }
    listeners.add(listener);
    if (this.loaded) {
      const match = this.matches.get(key) ?? null;
      listener(match);
      if (!match) {
        void this.scanMissingRunMatches();
      }
    }
    if (!this.loaded) {
      void this.refresh();
    }
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        this.listeners.delete(key);
      }
    };
  }

  dispose(): void {
    this.generation += 1;
    this.listeners.clear();
    this.matches.clear();
    this.refreshPromise = undefined;
    this.runCandidates = [];
    this.runCandidateIndex = 0;
    this.runScanPromise = undefined;
    this.loaded = false;
    this.unsubscribeGateway();
  }

  private invalidate(): void {
    this.generation += 1;
    this.matches.clear();
    this.refreshPromise = undefined;
    this.runCandidates = [];
    this.runCandidateIndex = 0;
    this.runScanPromise = undefined;
    this.loaded = false;
    if (this.listeners.size > 0) {
      void this.refresh();
    }
  }

  private refresh(): Promise<void> {
    if (this.loaded) {
      return Promise.resolve();
    }
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    const generation = this.generation;
    const promise = this.loadMatches()
      .then((snapshot) => {
        if (generation !== this.generation) {
          return;
        }
        this.matches = snapshot.matches;
        this.runCandidates = snapshot.runCandidates;
        this.runCandidateIndex = 0;
        this.loaded = true;
        for (const [sessionKey, listeners] of this.listeners) {
          const match = snapshot.matches.get(sessionKey) ?? null;
          for (const listener of listeners) {
            listener(match);
          }
        }
        void this.scanMissingRunMatches();
      })
      .catch(() => {
        if (generation !== this.generation) {
          return;
        }
        for (const listeners of this.listeners.values()) {
          for (const listener of listeners) {
            listener(null);
          }
        }
      });
    this.refreshPromise = promise;
    void promise.finally(() => {
      if (this.refreshPromise === promise) {
        this.refreshPromise = undefined;
      }
    });
    return promise;
  }

  private async loadMatches(): Promise<WorkboardLookupSnapshot> {
    const payload = await this.client.request("workboard.cards.list", {});
    const cards = normalizeCardsPayload(payload).cards;
    const matches = indexCards(cards);
    const runCandidates = cards
      .toSorted((left, right) => right.updatedAt - left.updatedAt)
      .filter(
        (card) => card.metadata?.attempts === undefined && (card.runId || card.execution?.runId),
      )
      // Canonical list responses already carry attempt sessions. Keep the
      // older-gateway fallback bounded so an unrelated dashboard cannot scan a whole board.
      .slice(0, WORKBOARD_SESSION_RUN_LOOKUP_LIMIT);
    return { matches, runCandidates };
  }

  private missingSessionKeys(): string[] {
    return [...this.listeners.keys()].filter((sessionKey) => !this.matches.has(sessionKey));
  }

  private scanMissingRunMatches(): Promise<void> {
    if (!this.loaded || this.runScanPromise || this.missingSessionKeys().length === 0) {
      return this.runScanPromise ?? Promise.resolve();
    }
    const generation = this.generation;
    const promise = (async () => {
      while (
        generation === this.generation &&
        this.runCandidateIndex < this.runCandidates.length &&
        this.missingSessionKeys().length > 0
      ) {
        const card = this.runCandidates[this.runCandidateIndex];
        this.runCandidateIndex += 1;
        if (!card) {
          return;
        }
        let runs: unknown;
        try {
          runs = await this.client.request("workboard.cards.runs", { id: card.id });
        } catch {
          // A card can disappear between list and runs; continue the bounded sequential scan.
          continue;
        }
        if (generation !== this.generation) {
          return;
        }
        const match = cardMatch(card);
        for (const sessionKey of runSessionKeys(runs)) {
          if (this.matches.has(sessionKey)) {
            continue;
          }
          this.matches.set(sessionKey, match);
          for (const listener of this.listeners.get(sessionKey) ?? []) {
            listener(match);
          }
        }
      }
    })();
    this.runScanPromise = promise;
    void promise.finally(() => {
      if (this.runScanPromise !== promise) {
        return;
      }
      this.runScanPromise = undefined;
      if (
        generation === this.generation &&
        this.runCandidateIndex < this.runCandidates.length &&
        this.missingSessionKeys().length > 0
      ) {
        void this.scanMissingRunMatches();
      }
    });
    return promise;
  }
}

type LookupEntry = {
  lookup: WorkboardSessionCardLookup;
  consumers: number;
};

const lookups = new WeakMap<WorkboardLookupClient, LookupEntry>();

export type WorkboardSessionCardLookupLease = {
  subscribe: (sessionKey: string, listener: WorkboardSessionCardListener) => () => void;
  release: () => void;
};

export function acquireWorkboardSessionCardLookup(
  client: WorkboardLookupClient,
): WorkboardSessionCardLookupLease {
  let entry = lookups.get(client);
  if (!entry) {
    entry = { lookup: new WorkboardSessionCardLookup(client), consumers: 0 };
    lookups.set(client, entry);
  }
  const acquiredEntry = entry;
  acquiredEntry.consumers += 1;
  let released = false;
  return {
    subscribe: (sessionKey, listener) => acquiredEntry.lookup.subscribe(sessionKey, listener),
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const current = lookups.get(client);
      if (!current || current !== acquiredEntry) {
        return;
      }
      current.consumers -= 1;
      if (current.consumers === 0) {
        lookups.delete(client);
        current.lookup.dispose();
      }
    },
  };
}
