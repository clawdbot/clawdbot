import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createWorkboardClient, type GatewayBrowserClient } from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import { isActiveWorkboardCard, nextWorkboardCardPosition } from "../lib/workboard/card-state.ts";
import { moveWorkboardCard } from "../lib/workboard/mutations.ts";
import { normalizeCardsPayload } from "../lib/workboard/normalization.ts";
import { getWorkboardState } from "../lib/workboard/runtime.ts";
import {
  WORKBOARD_CHANGED_EVENT,
  type WorkboardCard,
  type WorkboardStatus,
} from "../lib/workboard/types.ts";

export type WorkboardWidgetRuntime = {
  owner: object;
  client: GatewayBrowserClient;
  connected: boolean;
  loading: boolean;
  error: string;
  listeners: Set<() => void>;
  refresh: () => Promise<void>;
  notify: () => void;
  dispose: () => void;
};

const runtimes = new WeakMap<ControlUiHost, WorkboardWidgetRuntime>();

export function acquireWidgetRuntime(host: ControlUiHost, listener: () => void) {
  let runtime = runtimes.get(host);
  if (!runtime) {
    let disposed = false;
    let generation = 0;
    let pending = false;
    let load: Promise<void> | null = null;
    const current: WorkboardWidgetRuntime = {
      owner: {},
      client: createWorkboardClient(host),
      connected: host.connection.connected,
      loading: false,
      error: "",
      listeners: new Set(),
      notify() {
        for (const notify of current.listeners) {
          notify();
        }
      },
      async refresh() {
        if (disposed || !current.connected) {
          return;
        }
        pending = true;
        if (load) {
          return load;
        }
        const epoch = generation;
        const isCurrent = () => !disposed && epoch === generation;
        const run = (async () => {
          while (pending && isCurrent() && current.connected) {
            pending = false;
            current.loading = true;
            current.error = "";
            current.notify();
            try {
              const snapshot = normalizeCardsPayload(
                await current.client.request("workboard.cards.list", {}),
              );
              if (!isCurrent()) {
                return;
              }
              const state = getWorkboardState(current.owner);
              state.cards = snapshot.cards;
              state.statuses = snapshot.statuses;
              state.loaded = true;
              state.loadAttempted = true;
              state.mutationReadiness = "ready";
            } catch (error) {
              if (!isCurrent()) {
                return;
              }
              current.error = formatUiError(error);
            } finally {
              if (isCurrent()) {
                current.loading = false;
                current.notify();
              }
            }
          }
        })();
        load = run;
        try {
          await run;
        } finally {
          if (load === run) {
            load = null;
          }
        }
      },
      dispose() {
        disposed = true;
        generation += 1;
        stopHost();
        stopEvents();
        current.listeners.clear();
      },
    };
    const stopHost = host.subscribe(() => {
      if (current.connected !== host.connection.connected) {
        current.connected = host.connection.connected;
        generation += 1;
        load = null;
        pending = false;
        current.owner = {};
        current.loading = false;
        current.error = "";
        if (current.connected) {
          void current.refresh();
        }
      }
      current.notify();
    });
    const stopEvents = host.onEvent(WORKBOARD_CHANGED_EVENT, () => {
      void current.refresh();
    });
    runtime = current;
    runtimes.set(host, runtime);
  }
  const entry = runtime;
  entry.listeners.add(listener);
  if (!getWorkboardState(entry.owner).loaded && !entry.loading) {
    void entry.refresh();
  }
  return {
    runtime: entry,
    release() {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0 && runtimes.get(host) === entry) {
        runtimes.delete(host);
        entry.dispose();
      }
    },
  };
}

export class WorkboardWidgetModel {
  constructor(
    readonly host: ControlUiHost,
    readonly runtime: WorkboardWidgetRuntime,
    public props: Readonly<Record<string, unknown>>,
    private readonly isActive: () => boolean,
    private readonly mutationAllowed: () => boolean,
  ) {}
  get canMutate() {
    return this.isActive() && this.mutationAllowed();
  }
  get workboardStateHost() {
    return this.runtime.owner;
  }
  get workboardClient() {
    return this.isActive() && this.runtime.connected ? createWorkboardClient(this.host) : null;
  }
  get cards() {
    return getWorkboardState(this.runtime.owner).cards.filter(isActiveWorkboardCard);
  }
  get statuses() {
    return getWorkboardState(this.runtime.owner).statuses;
  }
  get loaded() {
    return getWorkboardState(this.runtime.owner).loaded;
  }
  get loading() {
    return this.runtime.loading;
  }
  get error() {
    return getWorkboardState(this.runtime.owner).error || this.runtime.error;
  }
  readStringProp(key: string) {
    const value = this.props[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  readPositiveIntegerProp(key: string, fallback: number) {
    const value = this.props[key];
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
  }
  retryLoad() {
    if (this.isActive()) {
      void this.runtime.refresh();
    }
  }
  syncFromHost() {
    this.runtime.notify();
  }
  async moveCard(card: WorkboardCard, status: WorkboardStatus) {
    const client = this.workboardClient;
    if (!client || !this.canMutate || !isActiveWorkboardCard(card) || card.status === status) {
      return;
    }
    const owner = this.runtime.owner;
    await moveWorkboardCard({
      host: owner,
      client,
      cardId: card.id,
      status,
      position: nextWorkboardCardPosition(getWorkboardState(owner).cards, card, status),
      requestUpdate: () => {
        if (owner === this.runtime.owner) {
          this.runtime.notify();
        }
      },
    });
  }
  async handleStatusChange(event: Event) {
    const card = this.cards.find((candidate) => candidate.id === this.readStringProp("cardId"));
    // SAFETY: The card renderer attaches this handler directly to its native status select.
    const selected = (event.currentTarget as HTMLSelectElement).value;
    const status = this.statuses.find((candidate) => candidate === selected);
    if (card && status) {
      await this.moveCard(card, status);
    }
  }
}
