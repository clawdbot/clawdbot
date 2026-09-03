import type { RouteLocation } from "@openclaw/uirouter";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { activityPersonFromPath, activityPersonLocation } from "../../app-route-paths.ts";
import type { PresenceViewer } from "../../lib/presence-users.ts";
import { createSessionEventRefreshCoordinator } from "../../lib/sessions/event-refresh-coordinator.ts";
import {
  canonicalSessionActivityLocation,
  sessionActivityLocation,
  type SessionActivityFilters,
} from "./session-activity.ts";

/** The Activity query owns its page; selecting a person must not replace the sidebar roster. */
export class SessionActivityController implements ReactiveController {
  result?: SessionsListResult;
  error?: string;
  loading = false;
  private client: GatewayBrowserClient | null = null;
  private queryKey?: string;
  private pending?: AbortController;
  private refreshPending = false;
  private filters: SessionActivityFilters | null = null;
  private normalizedLocation = "";
  private readonly observesPageLifecycle =
    typeof document !== "undefined" && typeof globalThis.addEventListener === "function";
  private pageActive = !this.observesPageLifecycle || document.visibilityState !== "hidden";
  private readonly eventRefresh = createSessionEventRefreshCoordinator({
    active: this.pageActive,
    refresh: async () => this.load(this.client, this.filters, true),
  });

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  hostConnected(): void {
    this.updatePageLifecycleListeners(true);
    if (this.observesPageLifecycle) {
      this.handlePageLifecycle(new Event("pageshow"));
    }
  }

  hostDisconnected(): void {
    this.updatePageLifecycleListeners(false);
    this.resetQuery();
  }

  private resetQuery(): void {
    this.eventRefresh.reset();
    this.pending?.abort();
    this.pending = undefined;
    this.client = null;
    this.queryKey = undefined;
    this.result = undefined;
    this.refreshPending = false;
    this.filters = null;
    this.normalizedLocation = "";
  }

  private personLabel(id: string, presence: readonly PresenceViewer[]): string | undefined {
    return (
      this.result?.people?.find((person) => person.identity.id === id)?.label ??
      presence.find((person) => person.identity?.id === id)?.name
    );
  }

  canonicalLocation(
    location: RouteLocation,
    basePath: string,
    presence: readonly PresenceViewer[],
  ): RouteLocation | null {
    if (!this.filters?.personId || !this.result?.involvingProfileId || this.loading) {
      return null;
    }
    const personId = this.result.involvingProfileId;
    const canonical = canonicalSessionActivityLocation(
      location,
      personId,
      this.personLabel(personId, presence),
      basePath,
    );
    if (!canonical) {
      this.normalizedLocation = "";
      return null;
    }
    const source = `${location.pathname}${location.search}${location.hash}`;
    if (this.normalizedLocation === source) {
      return null;
    }
    // The resolved ID owns the link; replace each stale name once without adding history.
    this.normalizedLocation = source;
    return canonical;
  }

  locationForFilters(
    filters: SessionActivityFilters,
    current: RouteLocation,
    basePath: string,
    presence: readonly PresenceViewer[],
  ) {
    const location = sessionActivityLocation(
      filters,
      basePath,
      filters.personId ? this.personLabel(filters.personId, presence) : undefined,
    );
    const currentId = this.result?.involvingProfileId ?? this.filters?.personId;
    if (filters.personId && filters.personId === currentId) {
      // Filter changes must not broaden an exact legacy bookmark into a shared prefix.
      location.pathname = activityPersonFromPath(current.pathname, basePath)
        ? current.pathname
        : activityPersonLocation(
            filters.personId,
            basePath,
            this.personLabel(filters.personId, presence),
            32,
          ).pathname;
    }
    return location;
  }

  private readonly handlePageLifecycle = (event: Event): void => {
    const leaving = event.type === "pagehide";
    this.pageActive = !leaving && document.visibilityState !== "hidden";
    this.eventRefresh.setActive(this.pageActive, leaving || this.pending !== undefined);
    if (!this.pageActive) {
      // The lifecycle coordinator owns catch-up after hiding, including queued in-flight work.
      this.refreshPending = false;
    }
  };

  private updatePageLifecycleListeners(add: boolean): void {
    if (!this.observesPageLifecycle) {
      return;
    }
    const method = add ? "addEventListener" : "removeEventListener";
    document[method]("visibilitychange", this.handlePageLifecycle);
    globalThis[method]("pagehide", this.handlePageLifecycle);
    globalThis[method]("pageshow", this.handlePageLifecycle);
  }

  invalidate(): void {
    if (this.client && this.filters) {
      this.eventRefresh.schedule();
    }
  }

  load(
    client: GatewayBrowserClient | null,
    filters: SessionActivityFilters | null,
    force = false,
  ): void {
    if (!client || !filters) {
      this.resetQuery();
      this.loading = false;
      this.host.requestUpdate();
      return;
    }
    const request = {
      archived: "all",
      includeGlobal: true,
      includeUnknown: true,
      includePeople: true,
      includeDerivedTitles: true,
      limit: 100,
      ...(filters.personId ? { involvingProfileId: filters.personId } : {}),
      ...(filters.query ? { search: filters.query } : {}),
      ...(filters.time === "all"
        ? {}
        : { activeMinutes: filters.time === "24h" ? 1440 : filters.time === "7d" ? 10080 : 43200 }),
    };
    const queryKey = JSON.stringify(request);
    const sameQuery = this.client === client && this.queryKey === queryKey;
    if (sameQuery && this.pending) {
      this.refreshPending ||= force;
      return;
    }
    if (!force && sameQuery) {
      return;
    }
    this.pending?.abort();
    this.eventRefresh.absorb();
    const pending = new AbortController();
    this.pending = pending;
    this.client = client;
    this.queryKey = queryKey;
    this.filters = filters;
    this.loading = true;
    this.error = undefined;
    if (!sameQuery) {
      this.result = undefined;
    }
    this.refreshPending = false;
    this.host.requestUpdate();
    void client
      .request<SessionsListResult>("sessions.list", request, { signal: pending.signal })
      .then((result) => {
        if (this.pending === pending) {
          this.result = result;
        }
      })
      .catch((error: unknown) => {
        if (this.pending === pending && !pending.signal.aborted) {
          this.error = error instanceof Error ? error.message : String(error);
        }
      })
      .finally(() => {
        if (this.pending === pending) {
          this.pending = undefined;
          this.loading = false;
          this.host.requestUpdate();
          if (this.refreshPending) {
            this.load(client, filters, true);
          }
        }
      });
  }
}
