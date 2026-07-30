import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
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
  @state() private error: string | null = null;
  @state() private cancellingTaskIds = new Set<string>();

  private client: GatewayBrowserClient | null = null;
  private operationEpoch = 0;
  private observedAgentScopeId: string | null | undefined;
  private gatewaySource?: ApplicationContext["gateway"];
  private taskRefreshEvents: TaskRefreshEventBuffer | null = null;
  private readonly listTask = new Task(this, {
    autoRun: false,
    // Gateway identity retires reconnect/source replacements even when they reuse a client.
    args: () =>
      [
        this.connected ? (this.gatewaySource ?? null) : null,
        this.connected ? this.client : null,
        this.context?.agentSelection.state.scopeId ?? null,
      ] as const,
    task: async ([gateway, client, scopeId], { signal }) => {
      if (!gateway || !client) {
        return initialState;
      }
      const buffer: TaskRefreshEventBuffer = {
        gateway,
        client,
        scopeId,
        events: [],
      };
      this.taskRefreshEvents = buffer;
      const agentId = scopeId ?? undefined;
      const [activePayload, recentPayload] = await Promise.all([
        client.request(
          "tasks.list",
          {
            status: ["queued", "running"],
            limit: 500,
            ...(agentId ? { agentId } : {}),
          },
          { signal },
        ),
        client.request("tasks.list", { limit: 200, ...(agentId ? { agentId } : {}) }, { signal }),
      ]);
      const active = normalizeTasksListResult(activePayload);
      const recent = normalizeTasksListResult(recentPayload);
      if (!active || !recent) {
        throw new Error(t("tasksPage.invalidResponse"));
      }
      return { active, recent, buffer };
    },
    onComplete: ({ active, recent, buffer }) => {
      // The active query is issued first; a same-millisecond recent page
      // must win running-progress ties when a pushed event is dropped.
      let tasks = mergeTaskLists(active, recent);
      for (const event of buffer.events) {
        tasks = applyTaskEvent(tasks, event).tasks;
      }
      this.tasks = tasks;
      if (this.taskRefreshEvents === buffer) {
        this.taskRefreshEvents = null;
      }
    },
    onError: (error) => {
      this.taskRefreshEvents = null;
      this.error = formatTaskError(error, t("tasksPage.loadFailed"));
    },
  });
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
    this.operationEpoch += 1;
    this.taskRefreshEvents = null;
    void this.listTask.run([null, null, null]);
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

  private refreshTasks(): Promise<void> {
    const gateway = this.gatewaySource;
    const client = this.client;
    if (!gateway || this.context.gateway !== gateway || !this.connected || !client) {
      return Promise.resolve();
    }
    const scopeId = this.context.agentSelection.state.scopeId;
    this.error = null;
    return this.listTask.run([gateway, client, scopeId]);
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
            ?disabled=${!this.connected || this.listTask.status === TaskStatus.PENDING}
            @click=${() => void this.refreshTasks()}
          >
            ${this.listTask.status === TaskStatus.PENDING
              ? t("common.refreshing")
              : t("common.refresh")}
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
        loading: this.listTask.status === TaskStatus.PENDING,
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
