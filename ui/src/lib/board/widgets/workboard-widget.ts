import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import type { PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";
import { formatUiError } from "../../format-error.ts";
import { isActiveWorkboardCard, nextWorkboardCardPosition } from "../../workboard/card-state.ts";
import { moveWorkboardCard } from "../../workboard/mutations.ts";
import { normalizeCardsPayload } from "../../workboard/normalization.ts";
import { getWorkboardState, type WorkboardHost } from "../../workboard/runtime.ts";
import {
  WORKBOARD_CHANGED_EVENT,
  type WorkboardCard,
  type WorkboardStatus,
} from "../../workboard/types.ts";
import type { BoardWidget } from "../types.ts";

type SharedWorkboardWidgetRuntime = {
  host: WorkboardHost;
  listeners: Set<(snapshot: ReturnType<typeof normalizeCardsPayload>) => void>;
  loadPromise?: Promise<ReturnType<typeof normalizeCardsPayload>>;
  snapshot?: ReturnType<typeof normalizeCardsPayload>;
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
    runtime.snapshot = snapshot;
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

  @property({ attribute: false }) widget?: BoardWidget;
  @property({ attribute: false }) sessionKey = "";
  @property({ type: Boolean }) active = true;
  @property({ type: Boolean }) canMutate = true;
  @property({ attribute: false }) hostRequestUpdate?: () => void;

  protected cards: WorkboardCard[] = [];
  protected statuses: readonly WorkboardStatus[] = [];
  protected loaded = false;
  protected error = "";

  private allCards: WorkboardCard[] = [];
  private workboardHost: WorkboardHost = {};
  private client: GatewayBrowserClient | null = null;
  private sharedRuntime: SharedWorkboardWidgetRuntime | null = null;
  private readonly refreshTask = new Task(this, {
    autoRun: false,
    args: () => [this.client, this.sharedRuntime, false as boolean, false as boolean] as const,
    task: async ([client, runtime, force, refreshAfterInflight]) => {
      if (!client || !runtime) {
        return initialState;
      }
      if (!force && runtime.snapshot) {
        return runtime.snapshot;
      }
      const pending = runtime.loadPromise;
      try {
        const snapshot = await loadSharedWorkboardCards(client, runtime);
        return refreshAfterInflight && pending
          ? loadSharedWorkboardCards(client, runtime)
          : snapshot;
      } catch (error) {
        if (!refreshAfterInflight || !pending) {
          throw error;
        }
        return loadSharedWorkboardCards(client, runtime);
      }
    },
    onError: (error) => {
      this.error = formatUiError(error);
      this.requestRender();
    },
  });
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
        if (this.active) {
          void this.refresh(true);
        }
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

  override shouldUpdate(): boolean {
    // @lit/task can schedule its host directly when a request settles. Keep
    // cached state, but defer the hidden render until active changes again.
    return this.active;
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.get("active") === false && this.active) {
      void this.refresh(true);
      return;
    }
    if (!this.active) {
      return;
    }
    if (!this.loaded && this.refreshTask.status === TaskStatus.INITIAL) {
      void this.refresh();
    }
  }

  override disconnectedCallback(): void {
    if (this.client && this.sharedRuntime) {
      releaseWorkboardWidgetRuntime(this.client, this.sharedRuntime, this.applySharedSnapshot);
    }
    void this.refreshTask.run([null, null, false, false]);
    this.client = null;
    this.sharedRuntime = null;
    this.allCards = [];
    this.cards = [];
    this.workboardHost = {};
    this.loaded = false;
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

  protected get loading(): boolean {
    return this.refreshTask.status === TaskStatus.PENDING;
  }

  protected async moveCard(card: WorkboardCard, status: WorkboardStatus): Promise<void> {
    const client = this.client;
    if (
      !this.active ||
      !client ||
      !this.canMutate ||
      !isActiveWorkboardCard(card) ||
      card.status === status
    ) {
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
    void this.refreshTask.run([null, null, false, false]);
    this.loaded = false;
    this.error = "";
    // A cached runtime still has another live same-client listener; the last
    // disconnect deletes it, while shared change events keep its snapshot current.
    if (this.sharedRuntime?.snapshot) {
      this.applySharedSnapshot(this.sharedRuntime.snapshot);
    }
    this.requestRender();
    if (nextClient && !this.sharedRuntime?.snapshot) {
      void this.refresh();
    }
  }

  private async refresh(force = false): Promise<void> {
    const client = this.client;
    const sharedRuntime = this.sharedRuntime;
    if (!this.active || !client || !sharedRuntime || (!force && this.loaded)) {
      return;
    }
    const refreshAfterInflight = force && this.refreshTask.status === TaskStatus.PENDING;
    if (!force && this.refreshTask.status === TaskStatus.PENDING) {
      return;
    }
    this.error = "";
    this.requestRender();
    await this.refreshTask.run([client, sharedRuntime, force, refreshAfterInflight]);
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
    if (!this.active) {
      return;
    }
    this.requestUpdate();
    this.hostRequestUpdate?.();
  }
}
