import { consume } from "@lit/context";
import { property } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";
import { isActiveWorkboardCard, nextWorkboardCardPosition } from "../../workboard/card-state.ts";
import { moveWorkboardCard } from "../../workboard/mutations.ts";
import { normalizeCardsPayload } from "../../workboard/normalization.ts";
import { getWorkboardState, type WorkboardHost } from "../../workboard/runtime.ts";
import {
  WORKBOARD_CHANGED_EVENT,
  type WorkboardCard,
  type WorkboardStatus,
} from "../../workboard/types.ts";
import type { BoardViewWidget } from "../view-types.ts";

type SharedWorkboardWidgetRuntime = {
  host: WorkboardHost;
  listeners: Set<(snapshot: ReturnType<typeof normalizeCardsPayload>) => void>;
  loadPromise?: Promise<ReturnType<typeof normalizeCardsPayload>>;
};

type SharedWorkboardWidgetSubscription = {
  listeners: Set<() => void>;
  unsubscribe: () => void;
};

const sharedWorkboardWidgetRuntimes = new WeakMap<
  GatewayBrowserClient,
  SharedWorkboardWidgetRuntime
>();
const sharedWorkboardWidgetSubscriptions = new WeakMap<
  ApplicationContext["gateway"],
  SharedWorkboardWidgetSubscription
>();

function acquireWorkboardWidgetRuntime(
  client: GatewayBrowserClient,
  listener: (snapshot: ReturnType<typeof normalizeCardsPayload>) => void,
): SharedWorkboardWidgetRuntime {
  let runtime = sharedWorkboardWidgetRuntimes.get(client);
  if (!runtime) {
    runtime = { host: {}, listeners: new Set() };
    sharedWorkboardWidgetRuntimes.set(client, runtime);
  }
  runtime.listeners.add(listener);
  return runtime;
}

function releaseWorkboardWidgetRuntime(
  client: GatewayBrowserClient,
  runtime: SharedWorkboardWidgetRuntime,
  listener: (snapshot: ReturnType<typeof normalizeCardsPayload>) => void,
): void {
  runtime.listeners.delete(listener);
  if (runtime.listeners.size === 0 && sharedWorkboardWidgetRuntimes.get(client) === runtime) {
    sharedWorkboardWidgetRuntimes.delete(client);
  }
}

function loadSharedWorkboardCards(
  client: GatewayBrowserClient,
  runtime: SharedWorkboardWidgetRuntime,
): Promise<ReturnType<typeof normalizeCardsPayload>> {
  if (runtime.loadPromise) {
    return runtime.loadPromise;
  }
  // Every widget on a Gateway shares one in-flight snapshot; a board change
  // must not multiply full-card-list requests by the visible widget count.
  const load = client.request("workboard.cards.list", {}).then(normalizeCardsPayload);
  runtime.loadPromise = load;
  const releaseLoad = () => {
    if (runtime.loadPromise === load) {
      runtime.loadPromise = undefined;
    }
  };
  void load.then((snapshot) => {
    releaseLoad();
    // A change can arrive after another widget started its snapshot request.
    // Broadcast the eventual post-change reload so idle widgets cannot stay stale.
    for (const listener of runtime.listeners) {
      listener(snapshot);
    }
  }, releaseLoad);
  return load;
}

function subscribeToSharedWorkboardChanges(
  gateway: ApplicationContext["gateway"],
  listener: () => void,
): () => void {
  let subscription = sharedWorkboardWidgetSubscriptions.get(gateway);
  if (!subscription) {
    const listeners = new Set<() => void>();
    const unsubscribe = gateway.subscribeEvents((event) => {
      if (event.event !== WORKBOARD_CHANGED_EVENT || gateway.snapshot.phase !== "connected") {
        return;
      }
      for (const onChange of listeners) {
        onChange();
      }
    });
    subscription = { listeners, unsubscribe };
    sharedWorkboardWidgetSubscriptions.set(gateway, subscription);
  }
  subscription.listeners.add(listener);
  return () => {
    subscription.listeners.delete(listener);
    if (
      subscription.listeners.size === 0 &&
      sharedWorkboardWidgetSubscriptions.get(gateway) === subscription
    ) {
      subscription.unsubscribe();
      sharedWorkboardWidgetSubscriptions.delete(gateway);
    }
  };
}

export abstract class WorkboardWidgetElement extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  protected context?: ApplicationContext;

  @property({ attribute: false }) widget?: BoardViewWidget;
  @property({ attribute: false }) sessionKey = "";
  @property({ type: Boolean }) canMutate = true;
  @property({ attribute: false }) hostRequestUpdate?: () => void;

  protected cards: WorkboardCard[] = [];
  protected statuses: readonly WorkboardStatus[] = [];
  protected loading = false;
  protected loaded = false;
  protected error = "";
  private loadAttempted = false;

  private allCards: WorkboardCard[] = [];
  private workboardHost: WorkboardHost = {};
  private client: GatewayBrowserClient | null = null;
  private sharedRuntime: SharedWorkboardWidgetRuntime | null = null;
  private refreshGeneration = 0;
  private refreshPromise: Promise<void> | null = null;
  private refreshPending = false;
  private readonly applySharedSnapshot = (
    snapshot: ReturnType<typeof normalizeCardsPayload>,
  ): void => {
    this.allCards = snapshot.cards;
    this.cards = snapshot.cards.filter(isActiveWorkboardCard);
    this.statuses = snapshot.statuses;
    this.loaded = true;
    this.error = "";
    this.requestRender();
  };
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) => {
      const sync = () => this.syncGateway(gateway.snapshot);
      sync();
      const unsubscribeSnapshot = gateway.subscribe(sync);
      const unsubscribeEvents = subscribeToSharedWorkboardChanges(gateway, () => {
        void this.refresh(true);
      });
      return () => {
        unsubscribeSnapshot();
        unsubscribeEvents();
      };
    },
  );

  override connectedCallback(): void {
    super.connectedCallback();
    this.syncGateway(this.context?.gateway.snapshot);
  }

  override updated(): void {
    if (!this.loadAttempted && !this.loading) {
      void this.refresh();
    }
  }

  override disconnectedCallback(): void {
    if (this.client && this.sharedRuntime) {
      releaseWorkboardWidgetRuntime(this.client, this.sharedRuntime, this.applySharedSnapshot);
    }
    this.refreshGeneration += 1;
    this.refreshPromise = null;
    this.refreshPending = false;
    this.client = null;
    this.sharedRuntime = null;
    this.allCards = [];
    this.cards = [];
    this.workboardHost = {};
    this.loaded = false;
    this.loadAttempted = false;
    this.loading = false;
    this.error = "";
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  protected readStringProp(key: string): string | undefined {
    const value = this.widget?.props?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  protected readPositiveIntegerProp(key: string, fallback: number): number {
    const value = this.widget?.props?.[key];
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
  }

  protected retryLoad(): void {
    void this.refresh(true);
  }

  protected async moveCard(card: WorkboardCard, status: WorkboardStatus): Promise<void> {
    const client = this.client;
    if (!client || !this.canMutate || !isActiveWorkboardCard(card) || card.status === status) {
      return;
    }
    const host = this.workboardHost;
    const state = getWorkboardState(host);
    state.cards = [...this.allCards];
    state.statuses = this.statuses;
    state.loaded = true;
    state.loadAttempted = true;
    state.mutationReadiness = "ready";
    await moveWorkboardCard({
      host,
      client,
      cardId: card.id,
      status,
      position: nextWorkboardCardPosition(state.cards, card, status),
      requestUpdate: () => {
        if (this.client === client && this.workboardHost === host) {
          this.syncFromHost();
        }
      },
    });
    if (this.client === client && this.workboardHost === host) {
      this.syncFromHost();
    }
  }

  private syncGateway(snapshot: ApplicationContext["gateway"]["snapshot"] | undefined): void {
    const nextClient = snapshot?.phase === "connected" ? snapshot.client : null;
    if (this.client === nextClient) {
      return;
    }
    if (this.client && this.sharedRuntime) {
      releaseWorkboardWidgetRuntime(this.client, this.sharedRuntime, this.applySharedSnapshot);
    }
    this.client = nextClient;
    // Pending mutation state belongs to its connection; never let its completion
    // block or replace cards loaded through the next Gateway client.
    this.sharedRuntime = nextClient
      ? acquireWorkboardWidgetRuntime(nextClient, this.applySharedSnapshot)
      : null;
    this.workboardHost = this.sharedRuntime?.host ?? {};
    this.allCards = [];
    this.cards = [];
    this.refreshGeneration += 1;
    this.refreshPromise = null;
    this.refreshPending = false;
    this.loaded = false;
    this.loadAttempted = false;
    this.loading = false;
    this.error = "";
    this.requestRender();
    if (nextClient) {
      void this.refresh(true);
    }
  }

  private async refresh(force = false): Promise<void> {
    const client = this.client;
    const sharedRuntime = this.sharedRuntime;
    if (!client || !sharedRuntime || (!force && this.loaded)) {
      return;
    }
    if (this.refreshPromise) {
      if (force) {
        this.refreshPending = true;
      }
      return await this.refreshPromise;
    }
    const generation = ++this.refreshGeneration;
    this.loadAttempted = true;
    this.loading = true;
    this.error = "";
    this.requestRender();
    const refresh = (async () => {
      try {
        await loadSharedWorkboardCards(client, sharedRuntime);
      } catch (error) {
        if (generation === this.refreshGeneration && client === this.client) {
          this.error = error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (generation === this.refreshGeneration) {
          this.loading = false;
          this.requestRender();
        }
      }
    })();
    this.refreshPromise = refresh;
    try {
      await refresh;
    } finally {
      if (this.refreshPromise === refresh) {
        this.refreshPromise = null;
        const shouldRefreshAgain =
          this.refreshPending && generation === this.refreshGeneration && client === this.client;
        this.refreshPending = false;
        if (shouldRefreshAgain) {
          await this.refresh(true);
        }
      }
    }
  }

  private syncFromHost(): void {
    const state = getWorkboardState(this.workboardHost);
    this.allCards = [...state.cards];
    this.cards = this.allCards.filter(isActiveWorkboardCard);
    this.statuses = state.statuses;
    this.error = state.error ?? "";
    this.requestRender();
  }

  private requestRender(): void {
    this.requestUpdate();
    this.hostRequestUpdate?.();
  }
}
