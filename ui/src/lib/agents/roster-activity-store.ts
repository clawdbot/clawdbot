import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import { createGatewayConnectionLifecycle } from "../gateway-connection-lifecycle.ts";
import { createSessionEventRefreshCoordinator } from "../sessions/event-refresh-coordinator.ts";
import { createSessionEventSubscriptionOwner } from "../sessions/session-event-subscription.ts";
import { buildSessionListParams } from "../sessions/session-requests.ts";
import { selectableAgentsList } from "./display.ts";
import { agentRosterCards } from "./roster-activity.ts";

type RosterContext = Pick<ApplicationContext, "gateway" | "agents" | "agentIdentity">;
type RosterActivitySnapshot = {
  readonly cards: ReadonlyArray<Readonly<ReturnType<typeof agentRosterCards>[number]>>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly subscriptionError: string | null;
};

const emptySnapshot: RosterActivitySnapshot = {
  cards: [],
  loading: false,
  error: null,
  subscriptionError: null,
};
const stores = new WeakMap<ApplicationGateway, RosterActivityStore>();

/** One activity window per Gateway, alive only while a roster is mounted. */
export function rosterActivityStore(context: RosterContext): RosterActivityStore {
  let store = stores.get(context.gateway);
  if (!store) {
    store = new RosterActivityStore(context);
    stores.set(context.gateway, store);
  }
  return store;
}

class RosterActivityStore {
  private current = emptySnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly lifecycle = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  private abort: AbortController | null = null;
  private cleanup: (() => void) | null = null;
  private readonly events = createSessionEventSubscriptionOwner({
    isCurrent: (scope) => this.lifecycle.isCurrent(scope),
    onError: (_scope, subscriptionError) => this.publish({ ...this.current, subscriptionError }),
    retryDelayMs: () => null,
  });
  private readonly refreshEvents = createSessionEventRefreshCoordinator({
    active: true,
    refresh: () => this.refresh(),
  });

  constructor(private readonly context: RosterContext) {}

  get snapshot(): RosterActivitySnapshot {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    // Each attachment owns a reference, even if two consumers reuse a callback.
    const notify = () => listener();
    this.listeners.add(notify);
    if (this.listeners.size === 1) {
      const { gateway } = this.context;
      const stopGateway = gateway.subscribe((snapshot) => this.applyGateway(snapshot));
      const stopEvents = gateway.subscribeEvents((event) => {
        if (
          this.lifecycle.capture() &&
          (event.event === "sessions.changed" || event.event === "session.message")
        ) {
          this.refreshEvents.schedule();
        }
      });
      this.cleanup = () => {
        stopGateway();
        stopEvents();
      };
      this.applyGateway(gateway.snapshot);
    }
    return () => {
      if (!this.listeners.delete(notify) || this.listeners.size > 0) {
        return;
      }
      this.cleanup?.();
      this.cleanup = null;
      this.lifecycle.transition({ client: null, phase: "stopped" });
      this.reset();
    };
  }

  private publish(snapshot: RosterActivitySnapshot) {
    this.current = snapshot;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private reset() {
    this.abort?.abort();
    this.abort = null;
    this.events.reset();
    this.refreshEvents.reset();
    this.publish(emptySnapshot);
  }

  private applyGateway(snapshot: ApplicationGatewaySnapshot) {
    if (this.lifecycle.transition(snapshot)) {
      this.reset();
      void this.refresh();
    }
    // Also expose connection metadata changes to the views.
    this.publish(this.current);
  }

  async refresh(): Promise<void> {
    const scope = this.lifecycle.capture();
    if (!scope) {
      return;
    }
    this.refreshEvents.absorb();
    void this.events.ensure(scope);
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const { signal } = abort;
    this.publish({ ...this.current, loading: true, error: null });
    try {
      const raw = await this.context.agents.ensureList();
      signal.throwIfAborted();
      if (!raw) {
        throw new Error(this.context.agents.state.agentsError ?? t("agentsHome.loadFailed"));
      }
      const agents = selectableAgentsList(raw);
      await this.context.agentIdentity.ensure(agents.agents.map((agent) => agent.id));
      signal.throwIfAborted();
      const sessions: GatewaySessionRow[] = [];
      let offset = 0;
      // Bound every refresh to three pages (300 recent sessions), including previews.
      for (let page = 0; page < 3; page += 1) {
        const result = await scope.client.request<SessionsListResult>(
          "sessions.list",
          buildSessionListParams({ includeLastMessage: true, limit: 100, offset }),
          { signal },
        );
        signal.throwIfAborted();
        sessions.push(...result.sessions);
        if (!result.hasMore || result.sessions.length === 0) {
          break;
        }
        offset = result.nextOffset ?? offset + result.sessions.length;
      }
      this.publish({
        ...this.current,
        cards: agentRosterCards(agents, sessions, (id) => this.context.agentIdentity.get(id)),
        loading: false,
      });
    } catch (error) {
      if (!signal.aborted) {
        this.publish({
          ...this.current,
          cards: [],
          loading: false,
          error: formatUiError(error, t("agentsHome.loadFailed")),
        });
      }
    } finally {
      if (this.abort === abort) {
        this.abort = null;
      }
    }
  }
}
