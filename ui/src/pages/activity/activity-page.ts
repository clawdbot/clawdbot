import { consume } from "@lit/context";
import { html, type PropertyValues } from "lit";
import { state } from "lit/decorators.js";
import type { EventLogEntry } from "../../api/event-log.ts";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import { uiSessionEventMatches } from "../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  parseToolActivityEvent,
  updateToolActivity,
  type ActivityEntry,
  type ActivityStatus,
} from "./tool-activity.ts";
import { renderActivity } from "./view.ts";

let activityClearBoundary: EventLogEntry | undefined;

class ActivityPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private entries: ActivityEntry[] = [];
  @state() private filterText = "";
  @state() private statusFilters: Record<ActivityStatus, boolean> = {
    running: true,
    done: true,
    error: true,
  };
  @state() private toolFilter = "";
  @state() private expandedIds = new Set<string>();
  @state() private autoFollow = true;
  @state() private atBottom = true;

  private sessionKey = "";
  private scrollFrame: number | null = null;
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) => {
      this.applyGatewaySnapshot(gateway, gateway.snapshot, true);
      const stopEvents = gateway.subscribeEvents((event) => {
        this.applyGatewayEvent(gateway, event, Date.now());
      });
      const stopGateway = gateway.subscribe((snapshot) =>
        this.applyGatewaySnapshot(gateway, snapshot, false),
      );
      return () => {
        stopGateway();
        stopEvents();
      };
    },
  );

  override updated(changed: PropertyValues) {
    if (this.autoFollow && this.atBottom && (changed.has("entries") || changed.has("autoFollow"))) {
      this.scheduleScroll(changed.has("autoFollow"));
    }
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    if (this.scrollFrame !== null) {
      cancelAnimationFrame(this.scrollFrame);
      this.scrollFrame = null;
    }
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(
    gateway: ApplicationContext["gateway"],
    snapshot: ApplicationGatewaySnapshot,
    sourceChanged: boolean,
  ) {
    const previousSessionKey = this.sessionKey;
    this.sessionKey = resolveSessionKey(loadSettings().sessionKey, snapshot.hello);
    if (sourceChanged || this.sessionKey !== previousSessionKey) {
      this.rebuildEntries(gateway, snapshot);
    }
  }

  private rebuildEntries(
    gateway: ApplicationContext["gateway"],
    snapshot: ApplicationGatewaySnapshot,
  ) {
    let entries: ActivityEntry[] = [];
    const eventLog = gateway.eventLog;
    const clearIndex = activityClearBoundary ? eventLog.indexOf(activityClearBoundary) : -1;
    const visibleEvents = clearIndex < 0 ? eventLog : eventLog.slice(0, clearIndex);
    for (const event of visibleEvents.toReversed()) {
      entries = this.reduceGatewayEvent(entries, snapshot, event.event, event.payload, event.ts);
    }
    if (entries.length > 0 || this.entries.length > 0) {
      this.entries = entries;
    }
    if (this.expandedIds.size > 0) {
      this.expandedIds = new Set();
    }
    this.atBottom = true;
  }

  private applyGatewayEvent(
    gateway: ApplicationContext["gateway"],
    event: GatewayEventFrame,
    receivedAt: number,
  ) {
    if (this.context.gateway !== gateway) {
      return;
    }
    const nextEntries = this.reduceGatewayEvent(
      this.entries,
      gateway.snapshot,
      event.event,
      event.payload,
      receivedAt,
    );
    if (nextEntries !== this.entries) {
      this.entries = nextEntries;
    }
  }

  private reduceGatewayEvent(
    entries: ActivityEntry[],
    gateway: ApplicationGatewaySnapshot,
    eventName: string,
    payload: unknown,
    receivedAt: number,
  ): ActivityEntry[] {
    if (eventName !== "agent" && eventName !== "session.tool") {
      return entries;
    }
    const event = parseToolActivityEvent(payload, receivedAt);
    if (!event) {
      return entries;
    }
    if (
      !uiSessionEventMatches(
        {
          sessionKey: this.sessionKey,
          assistantAgentId: gateway.assistantAgentId,
          hello: gateway.hello,
        },
        event.sessionKey,
        event.agentId,
      )
    ) {
      return entries;
    }
    return updateToolActivity(entries, event);
  }

  private scheduleScroll(force = false) {
    if (this.scrollFrame !== null) {
      cancelAnimationFrame(this.scrollFrame);
    }
    void this.updateComplete.then(() => {
      if (!this.isConnected) {
        return;
      }
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        const container = this.querySelector<HTMLElement>(".activity-stream");
        if (!container) {
          return;
        }
        const distanceFromBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight;
        if (!force && (!this.autoFollow || (!this.atBottom && distanceFromBottom >= 120))) {
          return;
        }
        container.scrollTop = container.scrollHeight;
        this.atBottom = true;
      });
    });
  }

  private handleScroll(event: Event) {
    const container = event.currentTarget as HTMLElement | null;
    if (!container) {
      return;
    }
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    this.atBottom = distanceFromBottom < 120;
  }

  private clearEntries() {
    activityClearBoundary = this.context.gateway.eventLog[0];
    this.entries = [];
    this.expandedIds = new Set();
    this.atBottom = true;
  }

  override render() {
    const body = renderActivity({
      entries: this.entries,
      filterText: this.filterText,
      statusFilters: this.statusFilters,
      toolFilter: this.toolFilter,
      expandedIds: this.expandedIds,
      autoFollow: this.autoFollow,
      onFilterTextChange: (next) => (this.filterText = next),
      onToolFilterChange: (next) => (this.toolFilter = next),
      onStatusToggle: (status, enabled) => {
        this.statusFilters = { ...this.statusFilters, [status]: enabled };
      },
      onToggleAutoFollow: (next) => {
        this.autoFollow = next;
        if (next) {
          this.scheduleScroll(true);
        }
      },
      onClear: () => this.clearEntries(),
      onExpandAll: () => {
        this.expandedIds = new Set(this.entries.map((entry) => entry.id));
      },
      onCollapseAll: () => {
        this.expandedIds = new Set();
      },
      onEntryToggle: (id, open) => {
        const next = new Set(this.expandedIds);
        if (open) {
          next.add(id);
        } else {
          next.delete(id);
        }
        this.expandedIds = next;
      },
      onScroll: (event) => this.handleScroll(event),
    });
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("activity")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(body, { fillHeight: true })}
    `;
  }
}

customElements.define("openclaw-activity-page", ActivityPage);
