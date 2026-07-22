import { consume } from "@lit/context";
import { property } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";
import { moveWorkboardCard } from "../../workboard/mutations.ts";
import { normalizeCardsPayload } from "../../workboard/normalization.ts";
import { getWorkboardState, type WorkboardHost } from "../../workboard/runtime.ts";
import {
  WORKBOARD_CHANGED_EVENT,
  type WorkboardCard,
  type WorkboardStatus,
} from "../../workboard/types.ts";
import type { BoardViewWidget } from "../view-types.ts";

export abstract class WorkboardWidgetElement extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  protected context?: ApplicationContext;

  @property({ attribute: false }) widget?: BoardViewWidget;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) hostRequestUpdate?: () => void;

  protected cards: WorkboardCard[] = [];
  protected statuses: readonly WorkboardStatus[] = [];
  protected loading = false;
  protected loaded = false;
  protected error = "";
  private loadAttempted = false;

  private readonly workboardHost: WorkboardHost = {};
  private client: GatewayBrowserClient | null = null;
  private refreshGeneration = 0;
  private refreshPromise: Promise<void> | null = null;
  private refreshPending = false;
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) => {
      const sync = () => this.syncGateway(gateway.snapshot);
      sync();
      const unsubscribeSnapshot = gateway.subscribe(sync);
      const unsubscribeEvents = gateway.subscribeEvents((event) => {
        if (event.event === WORKBOARD_CHANGED_EVENT && gateway.snapshot.connected) {
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

  override updated(): void {
    if (!this.loadAttempted && !this.loading) {
      void this.refresh();
    }
  }

  override disconnectedCallback(): void {
    this.refreshGeneration += 1;
    this.refreshPromise = null;
    this.refreshPending = false;
    this.client = null;
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
    if (!client || card.status === status) {
      return;
    }
    const state = getWorkboardState(this.workboardHost);
    state.cards = [...this.cards];
    state.statuses = this.statuses;
    state.loaded = true;
    state.loadAttempted = true;
    state.mutationReadiness = "ready";
    const position =
      Math.max(
        -1,
        ...state.cards
          .filter((candidate) => candidate.status === status)
          .map((candidate) => candidate.position),
      ) + 1;
    await moveWorkboardCard({
      host: this.workboardHost,
      client,
      cardId: card.id,
      status,
      position,
      requestUpdate: () => this.syncFromHost(),
    });
    this.syncFromHost();
  }

  private syncGateway(snapshot: ApplicationContext["gateway"]["snapshot"] | undefined): void {
    const nextClient = snapshot?.connected ? snapshot.client : null;
    if (this.client === nextClient) {
      return;
    }
    this.client = nextClient;
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
    if (!client || (!force && this.loaded)) {
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
        const normalized = normalizeCardsPayload(await client.request("workboard.cards.list", {}));
        if (generation !== this.refreshGeneration || client !== this.client) {
          return;
        }
        this.cards = normalized.cards;
        this.statuses = normalized.statuses;
        this.loaded = true;
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
    this.cards = [...state.cards];
    this.statuses = state.statuses;
    this.error = state.error ?? "";
    this.requestRender();
  }

  private requestRender(): void {
    this.requestUpdate();
    this.hostRequestUpdate?.();
  }
}
