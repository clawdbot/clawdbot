import { t } from "../i18n/index.ts";
import {
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
  SidebarSessionPatch,
} from "./app-sidebar-session-types.ts";
import type { SessionMenuAction } from "./session-menu.ts";

/** Session patch, fork, archive, and delete operations. */
export abstract class AppSidebarSessionMutationsElement extends AppSidebarSessionNavigationElement {
  protected readonly patchSession = async (
    session: SidebarRecentSession,
    patch: SidebarSessionPatch,
    scope: SidebarSessionMutationScope | null = this.beginSessionMutation(),
  ): Promise<SidebarSessionMutationResult> => {
    if (!scope) {
      return "stale";
    }
    const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
    try {
      const patched = await scope.sessions.patch(session.key, patch, { agentId });
      if (!this.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
      if (!patched) {
        if (scope.sessions.state.error) {
          this.publishSessionMutationError(scope, scope.sessions.state.error);
        }
        return "failed";
      }
      if (patch.archived !== true || !session.active) {
        return "completed";
      }
      this.replaceCurrentSession(
        buildAgentMainSessionKey({
          agentId,
          mainKey: resolveUiConfiguredMainKey({
            agentsList: scope.context.agents.state.agentsList,
            hello: scope.gateway.snapshot.hello,
          }),
        }),
      );
      return "completed";
    } catch (error) {
      if (!this.isSessionMutationScopeCurrent(scope)) {
        return "stale";
      }
      this.publishSessionMutationError(scope, error);
      return "failed";
    }
  };

  protected async patchSessions(
    rows: readonly SidebarRecentSession[],
    patch: SidebarSessionPatch,
    scope: SidebarSessionMutationScope | null = this.beginSessionMutation(),
  ): Promise<SidebarSessionMutationResult> {
    if (!scope) {
      return "stale";
    }
    let result: SidebarSessionMutationResult = "completed";
    // Sequential like deleteMany: parallel patches would race the shared
    // session-state publishes inside the capability.
    for (const row of rows) {
      const rowResult = await this.patchSession(row, patch, scope);
      if (rowResult === "stale") {
        return "stale";
      }
      if (rowResult === "failed") {
        result = "failed";
      }
    }
    return result;
  }

  /** One confirm and one preserved-worktrees alert for the whole selection. */
  protected async deleteSessionsBatch(rows: readonly SidebarRecentSession[]) {
    if (rows.length === 0) {
      return;
    }
    if (!window.confirm(t("sessionsView.deleteSessionsConfirm", { count: String(rows.length) }))) {
      return;
    }
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    try {
      const result = await scope.sessions.deleteMany(
        rows.map((row) => ({
          key: row.key,
          agentId: parseAgentSessionKey(row.key)?.agentId ?? scope.selectedAgentId,
          deleteTranscript: true,
        })),
      );
      if (!this.isSessionMutationScopeCurrent(scope)) {
        return;
      }
      if (result.preservedWorktrees.length > 0) {
        window.alert(
          t("sessionsView.deletePreservedWorktrees", {
            count: String(result.preservedWorktrees.length),
            branches: result.preservedWorktrees.map((worktree) => worktree.branch).join(", "),
          }),
        );
        if (!this.isSessionMutationScopeCurrent(scope)) {
          return;
        }
      }
      const deletedActive = rows.find((row) => row.active && result.deleted.includes(row.key));
      if (deletedActive) {
        this.replaceCurrentSession(
          buildAgentMainSessionKey({
            agentId: parseAgentSessionKey(deletedActive.key)?.agentId ?? scope.selectedAgentId,
            mainKey: resolveUiConfiguredMainKey({
              agentsList: scope.context.agents.state.agentsList,
              hello: scope.gateway.snapshot.hello,
            }),
          }),
        );
      }
      if (result.errors.length > 0) {
        this.publishSessionMutationError(scope, result.errors.join("; "));
      }
    } catch (error) {
      this.publishSessionMutationError(scope, error);
    }
  }

  protected runBatchSessionAction(
    action: SessionMenuAction,
    rows: SidebarRecentSession[],
    allUnread: boolean,
  ) {
    switch (action.kind) {
      case "toggle-unread":
        void this.patchSessions(rows, { unread: !allUnread });
        break;
      case "move-to-group":
        void this.patchSessions(
          rows.filter((row) => (row.category ?? null) !== action.category),
          { category: action.category },
        );
        break;
      case "new-group":
        this.createSessionGroup(rows);
        break;
      case "toggle-archived":
        void this.patchSessions(rows, { archived: true });
        break;
      case "delete":
        void this.deleteSessionsBatch(rows);
        break;
      default:
        break;
    }
  }

  protected async forkSession(session: SidebarRecentSession) {
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
    try {
      const key = await scope.sessions.create({
        parentSessionKey: session.key,
        fork: true,
        agentId,
      });
      if (!this.isSessionMutationScopeCurrent(scope)) {
        return;
      }
      if (key) {
        this.selectSession(key);
      } else {
        this.publishSessionMutationError(
          scope,
          scope.sessions.state.error ?? t("newSession.createFailed"),
        );
      }
    } catch (error) {
      this.publishSessionMutationError(scope, error);
    }
  }

  protected async stopCloudWorker(session: SidebarRecentSession) {
    if (
      !session.cloudWorkerActive ||
      session.hasActiveRun ||
      !window.confirm(t("sessionsView.stopCloudWorkerConfirm", { session: session.label }))
    ) {
      return;
    }
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
    try {
      await scope.client.request(
        "sessions.reclaim",
        { key: session.key, agentId },
        { timeoutMs: 10 * 60_000 },
      );
      if (!this.isSessionMutationScopeCurrent(scope)) {
        return;
      }
      await scope.sessions.refresh({ agentId, force: true });
    } catch (error) {
      this.publishSessionMutationError(scope, error);
    }
  }

  protected async deleteSession(session: SidebarRecentSession) {
    if (!window.confirm(t("sessionsView.deleteSessionConfirm", { session: session.label }))) {
      return;
    }
    const scope = this.beginSessionMutation();
    if (!scope) {
      return;
    }
    const agentId = parseAgentSessionKey(session.key)?.agentId ?? scope.selectedAgentId;
    try {
      const outcome = await scope.sessions.delete(session.key, {
        agentId,
        deleteTranscript: true,
      });
      if (!this.isSessionMutationScopeCurrent(scope)) {
        return;
      }
      // Dirty/unpushed checkouts survive deletion; offer explicit removal.
      if (outcome.worktreePreserved) {
        const preserved = outcome.worktreePreserved;
        if (
          window.confirm(
            t("sessionsView.deletePreservedWorktreeConfirm", { branch: preserved.branch }),
          )
        ) {
          if (!this.isSessionMutationScopeCurrent(scope)) {
            return;
          }
          try {
            await scope.client.request("worktrees.remove", {
              id: preserved.id,
              force: true,
            });
          } catch (error) {
            this.publishSessionMutationError(scope, error);
          }
          if (!this.isSessionMutationScopeCurrent(scope)) {
            return;
          }
        }
      }
      if (!outcome.deleted || !session.active) {
        return;
      }
      this.replaceCurrentSession(
        buildAgentMainSessionKey({
          agentId,
          mainKey: resolveUiConfiguredMainKey({
            agentsList: scope.context.agents.state.agentsList,
            hello: scope.gateway.snapshot.hello,
          }),
        }),
      );
    } catch (error) {
      this.publishSessionMutationError(scope, error);
    }
  }

  protected abstract createSessionGroup(sessions?: readonly SidebarRecentSession[]): void;
}
