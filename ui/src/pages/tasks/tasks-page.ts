import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorReadAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { t } from "../../i18n/index.ts";
import { watchAgentScope } from "../../lib/agents/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
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
  normalizeTasksGetResult,
  normalizeTasksListResult,
  normalizeTasksRecoveryResult,
} from "../../lib/tasks/data.ts";
import type { TaskSummary } from "../../lib/tasks/task-summary.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderTasks } from "./view.ts";

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

async function loadActiveTaskPages(params: {
  client: GatewayBrowserClient;
  agentId: string | undefined;
  signal: AbortSignal;
}): Promise<TaskSummary[]> {
  let tasks: TaskSummary[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  while (true) {
    const payload = await params.client.request(
      "tasks.list",
      {
        status: ["queued", "running"],
        limit: 500,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      },
      { signal: params.signal },
    );
    const page = normalizeTasksListResult(payload);
    if (!page) {
      throw new Error(t("tasksPage.invalidResponse"));
    }
    tasks = mergeTaskLists(tasks, page.tasks);
    if (page.nextCursor === undefined) {
      return tasks;
    }
    // Cursors are opaque, so revisiting any prior token is the only safe
    // client-side definition of a non-advancing page sequence.
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
      throw new Error(t("tasksPage.invalidResponse"));
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

class TasksPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private tasks: TaskSummary[] = [];
  @state() private error: string | null = null;
  @state() private cancellingTaskIds = new Set<string>();

  private taskRefreshEvents: TaskRefreshEventBuffer | null = null;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      this.tasks = [];
      this.error = null;
    },
    invalidateRequests: () => this.cancelGatewayWork(),
    onSnapshot: () => {
      if (this.gateway.connected) {
        void this.context.agents.ensureList();
      }
    },
    ensureInitialData: () => void this.refreshTasks(),
  });
  private readonly observeAgentScope = watchAgentScope(() => {
    this.gateway.invalidate();
    this.cancelGatewayWork();
    this.tasks = [];
    if (this.gateway.connected) {
      void this.refreshTasks();
    }
    this.requestUpdate();
  });

  private bufferTaskRefreshEvent(event: TaskRefreshEvent | null) {
    const buffer = this.taskRefreshEvents;
    if (
      event &&
      event.action !== "restored" &&
      buffer &&
      buffer.gateway === this.gateway.gateway &&
      buffer.client === this.gateway.client &&
      buffer.scopeId === this.context.agentSelection.state.scopeId
    ) {
      buffer.events.push(event);
    }
  }

  private readonly listTask = new Task(this, {
    autoRun: false,
    // Gateway identity retires reconnect/source replacements even when they reuse a client.
    args: () =>
      [
        this.gateway.connected ? this.gateway.gateway : null,
        this.gateway.connected ? this.gateway.client : null,
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
      const [active, recentPayload] = await Promise.all([
        loadActiveTaskPages({ client, agentId, signal }),
        client.request("tasks.list", { limit: 200, ...(agentId ? { agentId } : {}) }, { signal }),
      ]);
      const recent = normalizeTasksListResult(recentPayload);
      if (!recent) {
        throw new Error(t("tasksPage.invalidResponse"));
      }
      return { active, recent: recent.tasks, buffer };
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
      this.error = formatUiError(error, t("tasksPage.loadFailed"));
    },
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const stopEvents = gateway.subscribeEvents((event) => {
          if (
            this.gateway.gateway !== gateway ||
            this.context.gateway !== gateway ||
            !this.gateway.connected ||
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
          if (
            normalizedEvent?.action === "deleted" ||
            (normalizedEvent?.action === "upserted" &&
              taskMatchesAgentScope(normalizedEvent.task, scopeId))
          ) {
            this.bufferTaskRefreshEvent(normalizedEvent);
          }
          this.tasks = result.tasks.filter((task) => taskMatchesAgentScope(task, scopeId));
        });
        return stopEvents;
      },
    )
    .effect(
      () => this.context?.agentSelection,
      (selection) => this.observeAgentScope(selection),
    )
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
    );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private cancelGatewayWork() {
    // Reconnects may reuse the client object; the epoch keeps pre-disconnect
    // cancellation responses from mutating the replacement task snapshot.
    this.taskRefreshEvents = null;
    void this.listTask.run([null, null, null]);
    this.cancellingTaskIds = new Set();
  }

  private refreshTasks(): Promise<void> {
    const gateway = this.gateway.gateway;
    const client = this.gateway.client;
    if (!gateway || this.context.gateway !== gateway || !this.gateway.connected || !client) {
      return Promise.resolve();
    }
    const scopeId = this.context.agentSelection.state.scopeId;
    this.error = null;
    return this.listTask.run([gateway, client, scopeId]);
  }

  private async cancelTask(taskId: string) {
    const scope = this.gateway.capture();
    const gateway = this.gateway.gateway;
    if (
      !scope ||
      !gateway ||
      this.context.gateway !== gateway ||
      this.cancellingTaskIds.has(taskId)
    ) {
      return;
    }
    this.cancellingTaskIds = new Set([...this.cancellingTaskIds, taskId]);
    this.error = null;
    try {
      const payload = await scope.client.request("tasks.cancel", { taskId });
      if (!this.gateway.isCurrent(scope)) {
        return;
      }
      const result = normalizeTasksCancelResult(payload);
      if (result?.task) {
        const event = normalizeTaskEventPayload({ action: "upserted", task: result.task });
        // Mutation replies are authoritative even if the best-effort registry
        // event is dropped while the matching pages are in flight.
        this.bufferTaskRefreshEvent(event);
        this.tasks = applyTaskEvent(this.tasks, { action: "upserted", task: result.task }).tasks;
      }
      // Refusals (already terminal, stale id, no cancellation handle) are
      // successful responses with cancelled=false; surface them like errors.
      if (!result?.cancelled) {
        this.error = formatUiExternalText(result?.reason, t("tasksPage.cancelFailed"));
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error, t("tasksPage.cancelFailed"));
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        const next = new Set(this.cancellingTaskIds);
        next.delete(taskId);
        this.cancellingTaskIds = next;
      }
    }
  }

  private async recoverTask(taskId: string, action: "retry" | "dismiss") {
    const scope = this.gateway.capture();
    const gateway = this.gateway.gateway;
    if (
      !scope ||
      !gateway ||
      this.context.gateway !== gateway ||
      this.cancellingTaskIds.has(taskId)
    ) {
      return;
    }
    this.cancellingTaskIds = new Set([...this.cancellingTaskIds, taskId]);
    this.error = null;
    try {
      const payload =
        action === "retry"
          ? await scope.client.request("tasks.retry", { taskIds: [taskId] })
          : await scope.client.request("tasks.dismiss", { taskIds: [taskId] });
      if (!this.gateway.isCurrent(scope)) {
        return;
      }
      const result = normalizeTasksRecoveryResult(payload)?.results[0];
      if (!result?.ok) {
        this.error = formatUiExternalText(result?.reason, t("tasksPage.recoveryFailed"));
        return;
      }
      if (result.task) {
        const event = normalizeTaskEventPayload({
          action: "upserted",
          task: result.task,
        });
        this.bufferTaskRefreshEvent(event);
        this.tasks = applyTaskEvent(this.tasks, event).tasks;
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error, t("tasksPage.recoveryFailed"));
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        const next = new Set(this.cancellingTaskIds);
        next.delete(taskId);
        this.cancellingTaskIds = next;
      }
    }
  }

  private async copyTaskResult(taskId: string) {
    const scope = this.gateway.capture();
    const gateway = this.gateway.gateway;
    if (!scope || !gateway || this.context.gateway !== gateway) {
      return;
    }
    try {
      const detail = normalizeTasksGetResult(await scope.client.request("tasks.get", { taskId }));
      if (!this.gateway.isCurrent(scope)) {
        return;
      }
      const result = detail?.result ?? detail?.progressSummary;
      if (!result) {
        this.error = t("tasksPage.recoveryFailed");
        return;
      }
      await navigator.clipboard.writeText(result);
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error, t("tasksPage.recoveryFailed"));
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
            ?disabled=${!this.gateway.connected || this.listTask.status === TaskStatus.PENDING}
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
        connected: this.gateway.connected,
        canCopy: hasOperatorReadAccess(this.context.gateway.snapshot.hello?.auth ?? null),
        // Task mutations need operator.write; read-only operators get no mutation buttons.
        canCancel: hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null),
        loading: this.listTask.status === TaskStatus.PENDING,
        error: this.error,
        tasks: this.tasks,
        cancellingTaskIds: this.cancellingTaskIds,
        sessionRow: (sessionKey) => findUiSessionRow(this.context, sessionKey),
        onCancel: (taskId) => void this.cancelTask(taskId),
        onRetry: (taskId) => void this.recoverTask(taskId, "retry"),
        onDismiss: (taskId) => void this.recoverTask(taskId, "dismiss"),
        onCopyResult: (taskId) => void this.copyTaskResult(taskId),
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
