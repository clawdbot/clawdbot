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
import { searchForSession } from "../../lib/sessions/index.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import {
  applyTaskEvent,
  mergeTaskLists,
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
          this.tasks = result.tasks.filter((task) =>
            taskMatchesAgentScope(task, this.context.agentSelection.state.scopeId),
          );
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
    const connectionChanged = this.connected !== snapshot.connected;
    if (identityChanged || connectionChanged) {
      this.invalidateGatewayWork();
    }
    if (identityChanged) {
      this.client = snapshot.client;
      this.tasks = [];
      this.error = null;
    }
    this.connected = snapshot.connected;
    if (snapshot.connected) {
      void this.context.agents.ensureList();
    }
  }

  private invalidateGatewayWork() {
    // Reconnects may reuse the client object; the epoch keeps pre-disconnect
    // cancellation responses from mutating the replacement task snapshot.
    this.loadGeneration += 1;
    this.operationEpoch += 1;
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
    this.loading = true;
    this.error = null;
    try {
      const agentId = this.context.agentSelection.state.scopeId ?? undefined;
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
      const tasks = mergeTaskLists(recent, active);
      if (this.isLoadScopeCurrent(gateway, client, generation)) {
        this.tasks = tasks;
      }
    } catch (error) {
      if (this.isLoadScopeCurrent(gateway, client, generation)) {
        this.error = formatTaskError(error, t("tasksPage.loadFailed"));
      }
    } finally {
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
        connected: this.connected,
        // tasks.cancel needs operator.write; read-only operators get no button.
        canCancel: hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null),
        loading: this.loading,
        error: this.error,
        tasks: this.tasks,
        cancellingTaskIds: this.cancellingTaskIds,
        onCancel: (taskId) => void this.cancelTask(taskId),
        onNavigateToChat: (sessionKey) =>
          this.context.navigate("chat", { search: searchForSession(sessionKey) }),
      })}
    `;
  }
}

if (!customElements.get("openclaw-tasks-page")) {
  customElements.define("openclaw-tasks-page", TasksPage);
}
