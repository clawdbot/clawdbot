import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { t } from "../../i18n/index.ts";
import {
  findUiSessionRow,
  resolveSessionPreferredFaceForKey,
  resolveSessionNavigationAgentId,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import {
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import {
  applyTaskEvent,
  mergeTaskLists,
  normalizeTaskEventPayload,
  normalizeTasksCancelResult,
  normalizeTasksListResult,
  type TaskSummary,
} from "../../lib/tasks/data.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderTasks } from "./view.ts";

function formatTaskError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return typeof error === "string" && error.trim() ? error.trim() : fallback;
}

function taskMatchesAgentScope(task: TaskSummary, agentId: string | null): boolean {
  if (!agentId) {
    return true;
  }
  if (task.agentId?.trim()) {
    return task.agentId.trim().toLowerCase() === agentId;
  }
  return [task.sessionKey, task.childSessionKey, task.ownerKey].some(
    (key) => parseAgentSessionKey(key)?.agentId === agentId,
  );
}

type TaskRefreshEvent = NonNullable<ReturnType<typeof normalizeTaskEventPayload>>;

type TaskRefreshEventBuffer = {
  generation: number;
  gateway: ApplicationContext["gateway"];
  client: GatewayBrowserClient;
  scopeId: string | null;
  events: TaskRefreshEvent[];
};

class TasksPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private tasks: TaskSummary[] = [];
  @state() private connected = false;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private cancellingTaskIds = new Set<string>();

  private client: GatewayBrowserClient | null = null;
  private loadGeneration = 0;
  private operationEpoch = 0;
  private observedAgentScopeId: string | null | undefined;
  private gatewaySource?: ApplicationContext["gateway"];
  private taskRefreshEvents: TaskRefreshEventBuffer | null = null;
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const sourceChanged = this.gatewaySource !== undefined && this.gatewaySource !== gateway;
        this.gatewaySource = gateway;
        this.applyGatewaySnapshot(gateway.snapshot, sourceChanged);
        const stopGateway = gateway.subscribe((snapshot) => {
          if (this.gatewaySource !== gateway || this.context.gateway !== gateway) {
            return;
          }
          const wasConnected = this.connected;
          const previousClient = this.client;
          this.applyGatewaySnapshot(snapshot, false);
          if (this.connected && (this.client !== previousClient || !wasConnected)) {
            void this.refreshTasks();
          }
        });
        const stopEvents = gateway.subscribeEvents((event) => {
          if (
            this.gatewaySource !== gateway ||
            this.context.gateway !== gateway ||
            !this.connected ||
            event.event !== "task"
          ) {
            return;
          }
          const result = applyTaskEvent(this.tasks, event.payload);
          if (result.refetch) {
            void this.refreshTasks();
            return;
          }
          const scopeId = this.context.agentSelection.state.scopeId;
          const normalizedEvent = normalizeTaskEventPayload(event.payload);
          const buffer = this.taskRefreshEvents;
          if (
            normalizedEvent &&
            normalizedEvent.action !== "restored" &&
            buffer &&
            buffer.generation === this.loadGeneration &&
            buffer.gateway === gateway &&
            buffer.client === this.client &&
            buffer.scopeId === scopeId &&
            (normalizedEvent.action === "deleted" ||
              taskMatchesAgentScope(normalizedEvent.task, scopeId))
          ) {
            buffer.events.push(normalizedEvent);
          }
          this.tasks = result.tasks.filter((task) => taskMatchesAgentScope(task, scopeId));
        });
        if (this.connected) {
          void this.refreshTasks();
        }
        return () => {
          stopGateway();
          stopEvents();
        };
      },
    )
    .effect(
      () => this.context?.agentSelection,
      (selection) => {
        const sync = () => {
          const nextScopeId = selection.state.scopeId;
          if (this.observedAgentScopeId === undefined) {
            this.observedAgentScopeId = nextScopeId;
            return;
          }
          if (this.observedAgentScopeId === nextScopeId) {
            return;
          }
          this.observedAgentScopeId = nextScopeId;
          this.invalidateGatewayWork();
          this.tasks = [];
          if (this.connected) {
            void this.refreshTasks();
          }
          this.requestUpdate();
        };
        sync();
        return selection.subscribe(sync);
      },
    )
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
    );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.invalidateGatewayWork();
    this.gatewaySource = undefined;
    this.client = null;
    this.connected = false;
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot, sourceChanged: boolean) {
    const identityChanged = sourceChanged || this.client !== snapshot.client;
    const connectionChanged = this.connected !== (snapshot.phase === "connected");
    if (identityChanged || connectionChanged) {
      this.invalidateGatewayWork();
    }
    if (identityChanged) {
      this.client = snapshot.client;
      this.tasks = [];
      this.error = null;
    }
    this.connected = snapshot.phase === "connected";
    if (snapshot.phase === "connected") {
      void this.context.agents.ensureList();
    }
  }

  private invalidateGatewayWork() {
    // Reconnects may reuse the client object; the epoch keeps pre-disconnect
    // cancellation responses from mutating the replacement task snapshot.
    this.loadGeneration += 1;
    this.operationEpoch += 1;
    this.taskRefreshEvents = null;
    this.loading = false;
    this.cancellingTaskIds = new Set();
  }

  private isCancelScopeCurrent(
    gateway: ApplicationContext["gateway"],
    client: GatewayBrowserClient,
    epoch: number,
  ): boolean {
    return (
      this.isConnected &&
      this.connected &&
      this.gatewaySource === gateway &&
      this.context.gateway === gateway &&
      this.client === client &&
      this.operationEpoch === epoch
    );
  }

  private isLoadScopeCurrent(
    gateway: ApplicationContext["gateway"],
    client: GatewayBrowserClient,
    generation: number,
  ): boolean {
    return (
      this.isConnected &&
      this.connected &&
      this.gatewaySource === gateway &&
      this.context.gateway === gateway &&
      this.client === client &&
      this.loadGeneration === generation
    );
  }

  private async refreshTasks() {
    const gateway = this.gatewaySource;
    const client = this.client;
    if (!gateway || this.context.gateway !== gateway || !this.connected || !client) {
      return;
    }
    const generation = ++this.loadGeneration;
    const scopeId = this.context.agentSelection.state.scopeId;
    // Replay only events received during this exact scoped request; otherwise
    // late snapshot pages can undo concurrent completions, creations, or deletes.
    const taskRefreshEvents: TaskRefreshEventBuffer = {
      generation,
      gateway,
      client,
      scopeId,
      events: [],
    };
    this.taskRefreshEvents = taskRefreshEvents;
    this.loading = true;
    this.error = null;
    try {
      const agentId = scopeId ?? undefined;
      // Active tasks need their own query: the ledger pages newest-first, so a
      // long-running task can hide behind newer terminal records on page one.
      const [activePayload, recentPayload] = await Promise.all([
        client.request("tasks.list", {
          status: ["queued", "running"],
          limit: 500,
          ...(agentId ? { agentId } : {}),
        }),
        client.request("tasks.list", { limit: 200, ...(agentId ? { agentId } : {}) }),
      ]);
      const active = normalizeTasksListResult(activePayload);
      const recent = normalizeTasksListResult(recentPayload);
      if (!active || !recent) {
        throw new Error(t("tasksPage.invalidResponse"));
      }
      if (this.isLoadScopeCurrent(gateway, client, generation)) {
        // The active query is issued first; a same-millisecond recent page
        // must win running-progress ties when a pushed event is dropped.
        let tasks = mergeTaskLists(active, recent);
        for (const event of taskRefreshEvents.events) {
          tasks = applyTaskEvent(tasks, event).tasks;
        }
        this.tasks = tasks;
      }
    } catch (error) {
      if (this.isLoadScopeCurrent(gateway, client, generation)) {
        this.error = formatTaskError(error, t("tasksPage.loadFailed"));
      }
    } finally {
      if (this.taskRefreshEvents === taskRefreshEvents) {
        this.taskRefreshEvents = null;
      }
      if (this.isLoadScopeCurrent(gateway, client, generation)) {
        this.loading = false;
      }
    }
  }

  private async cancelTask(taskId: string) {
    const client = this.client;
    const gateway = this.gatewaySource;
    if (
      !gateway ||
      this.context.gateway !== gateway ||
      !this.connected ||
      !client ||
      this.cancellingTaskIds.has(taskId)
    ) {
      return;
    }
    const epoch = this.operationEpoch;
    this.cancellingTaskIds = new Set([...this.cancellingTaskIds, taskId]);
    this.error = null;
    try {
      const payload = await client.request("tasks.cancel", { taskId });
      if (!this.isCancelScopeCurrent(gateway, client, epoch)) {
        return;
      }
      const result = normalizeTasksCancelResult(payload);
      if (result?.task) {
        const event = normalizeTaskEventPayload({ action: "upserted", task: result.task });
        const buffer = this.taskRefreshEvents;
        if (
          event &&
          buffer &&
          buffer.generation === this.loadGeneration &&
          buffer.gateway === gateway &&
          buffer.client === client &&
          buffer.scopeId === this.context.agentSelection.state.scopeId
        ) {
          // Cancellation replies are authoritative even if the best-effort
          // registry event is dropped while the matching pages are in flight.
          buffer.events.push(event);
        }
        this.tasks = applyTaskEvent(this.tasks, { action: "upserted", task: result.task }).tasks;
      }
      // Refusals (already terminal, stale id, no cancellation handle) are
      // successful responses with cancelled=false; surface them like errors.
      if (!result?.cancelled) {
        this.error = result?.reason?.trim() || t("tasksPage.cancelFailed");
      }
    } catch (error) {
      if (this.isCancelScopeCurrent(gateway, client, epoch)) {
        this.error = formatTaskError(error, t("tasksPage.cancelFailed"));
      }
    } finally {
      if (this.isCancelScopeCurrent(gateway, client, epoch)) {
        const next = new Set(this.cancellingTaskIds);
        next.delete(taskId);
        this.cancellingTaskIds = next;
      }
    }
  }

  override render() {
    const fallbackAgentId = resolveSessionNavigationAgentId(this.context);
    return html`
      <section class="content-header content-header--page">
        <div>
          <div class="page-title">${titleForRoute("tasks")}</div>
        </div>
        <div class="page-header-actions">
          ${renderAgentScopeControl({
            agents: this.context.agents.state.agentsList?.agents ?? [],
            selection: this.context.agentSelection,
          })}
          <button
            class="btn"
            type="button"
            ?disabled=${!this.connected || this.loading}
            @click=${() => void this.refreshTasks()}
          >
            ${this.loading ? t("common.refreshing") : t("common.refresh")}
          </button>
        </div>
      </section>
      ${renderTasks({
        basePath: this.context.basePath,
        agentId: fallbackAgentId,
        mainKey: resolveUiConfiguredMainKey({
          agentsList: this.context.agents.state.agentsList,
          hello: this.context.gateway.snapshot.hello,
        }),
        connected: this.connected,
        // tasks.cancel needs operator.write; read-only operators get no button.
        canCancel: hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null),
        loading: this.loading,
        error: this.error,
        tasks: this.tasks,
        cancellingTaskIds: this.cancellingTaskIds,
        sessionRow: (sessionKey) => findUiSessionRow(this.context, sessionKey),
        onCancel: (taskId) => void this.cancelTask(taskId),
        onNavigateToChat: (sessionKey) => {
          const face = resolveSessionPreferredFaceForKey(this.context, sessionKey);
          this.context.navigate(
            face,
            sessionNavigationTarget({
              context: this.context,
              face,
              sessionKey,
              preferenceDerivedFace: true,
            }).options,
          );
        },
      })}
    `;
  }
}

if (!customElements.get("openclaw-tasks-page")) {
  customElements.define("openclaw-tasks-page", TasksPage);
}
