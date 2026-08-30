import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { SessionActivityFilters } from "./session-activity.ts";

/** The Activity query owns its page; selecting a person must not replace the sidebar roster. */
export class SessionActivityController implements ReactiveController {
  result?: SessionsListResult;
  error?: string;
  loading = false;
  private client: GatewayBrowserClient | null = null;
  private queryKey?: string;
  private pending?: AbortController;
  private refreshPending = false;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  hostDisconnected(): void {
    this.pending?.abort();
    this.pending = undefined;
    this.client = null;
    this.queryKey = undefined;
    this.result = undefined;
    this.refreshPending = false;
  }

  load(
    client: GatewayBrowserClient | null,
    filters: SessionActivityFilters | null,
    force = false,
  ): void {
    if (!client || !filters) {
      this.hostDisconnected();
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
    const pending = new AbortController();
    this.pending = pending;
    this.client = client;
    this.queryKey = queryKey;
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
