import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionsFilesRevealResult,
  SystemInfoResult,
  WorktreesBranchesResult,
  WorktreesListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { serializeSidebarEntry } from "../../app-navigation.ts";
import type { SidebarSessionMutationScope } from "../../components/app-sidebar-session-types.ts";
import type { SessionActionHost } from "../../components/session-organizer-operations.runtime.ts";
import { isCloudWorkerPlacementState } from "../../components/session-row-badges.ts";
import { t } from "../../i18n/index.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { openEditor } from "../../lib/editor-links.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { ChatPaneContext } from "./chat-pane-context.ts";
import { headerPlatformByClient } from "./chat-pane-shared.ts";
import { patchChatSessionLabel } from "./chat-state-route.ts";
import type { HeaderMenuAction } from "./components/chat-header-session-menu.ts";
import type { ChatPaneHeaderAction } from "./components/chat-pane-header.ts";
import { buildContinueInTerminalCommand } from "./continue-in-terminal-command.ts";

export abstract class ChatPaneSessionMenu extends ChatPaneContext {
  private headerSessionOperationsLoad: Promise<
    typeof import("../../components/session-organizer-operations.runtime.ts")
  > | null = null;
  protected async loadHeaderPlatform(
    client: GatewayBrowserClient,
    generation: number,
  ): Promise<void> {
    if (!isGatewayMethodAdvertised(this.context.gateway.snapshot, "system.info")) {
      return;
    }
    let platformRequest = headerPlatformByClient.get(client);
    if (!platformRequest) {
      platformRequest = client
        .request<SystemInfoResult>("system.info", {})
        .then((result) => result.platform)
        .catch(() => null);
      headerPlatformByClient.set(client, platformRequest);
    }
    try {
      const platform = await platformRequest;
      if (this.connectedClient === client && this.connectionGeneration === generation) {
        this.headerPlatform = platform;
      }
    } catch {
      // Optional label refinement. Generic file-manager copy remains correct.
    }
  }

  protected async handleHeaderSessionAction(action: HeaderMenuAction, row: GatewaySessionRow) {
    if (action.kind === "open-in") {
      openEditor(action.editor, action.path);
      return;
    }
    if (action.kind === "rename") {
      this.beginHeaderRename(row);
      return;
    }
    if (action.kind === "continue-in-terminal") {
      this.openContinueInTerminalDialog(row);
      return;
    }
    const scope = this.captureHeaderSessionActionScope();
    if (!scope) {
      this.publishHeaderError(t("sessionsView.actionRequiresConnection"));
      return;
    }
    const owner = this.headerOutcomeOwner;
    const session = {
      key: row.key,
      sessionId: row.sessionId,
      label:
        normalizeOptionalString(row.label) ?? normalizeOptionalString(this.paneTitle) ?? row.key,
      pinned: row.pinned === true,
      archived: row.archived === true,
      active: true,
      hasActiveRun: row.hasActiveRun ?? row.status === "running",
      gatewayHasActiveRun: row.hasActiveRun,
    };
    try {
      const operations = await (this.headerSessionOperationsLoad ??=
        import("../../components/session-organizer-operations.runtime.ts"));
      const host: SessionActionHost = {
        sessionData: {
          isSessionMutationScopeCurrent: (candidate) =>
            this.isHeaderSessionActionCurrent(candidate, owner),
          publishSessionMutationError: (candidate, error) => {
            if (this.isHeaderSessionActionCurrent(candidate, owner)) {
              this.publishHeaderError(error, owner);
            }
          },
          refreshSidebarSessions: async (agentId) => {
            await scope.sessions.refreshReplacement(agentId);
          },
        },
        pruneSidebarSessionEntry: (key) => {
          const entry = serializeSidebarEntry({ type: "session", key });
          const sidebarEntries = scope.context.navigation.snapshot.sidebarEntries.filter(
            (candidate) => candidate !== entry,
          );
          scope.context.navigation.update({ sidebarEntries });
        },
        replaceCurrentSession: (key) => this.onPaneSessionChange?.(this.paneId, key),
        selectSession: (key) => this.onPaneSessionChange?.(this.paneId, key),
        sidebarSessionStatusFilter: () => "active",
      };
      switch (action.kind) {
        case "fork":
          await operations.forkSession(host, session, scope);
          break;
        case "toggle-archived":
          if (session.archived) {
            await operations.patchSession(host, session, { archived: false }, scope);
          } else {
            await operations.archiveSessionWithUndo(host, session, scope);
          }
          break;
        case "delete":
          await operations.deleteSession(host, session, scope);
          break;
      }
    } catch (error) {
      if (this.isHeaderSessionActionCurrent(scope, owner)) {
        this.publishHeaderError(error, owner);
      }
    }
  }

  private resolveContinueInTerminalCommand(row: GatewaySessionRow, client: GatewayBrowserClient) {
    return buildContinueInTerminalCommand({
      gatewayUrl: client.gatewayUrl,
      sessionKey: row.key,
      rowAgentId: row.agentId,
      selectedAgentId: this.context.agentSelection.state.selectedId ?? undefined,
    });
  }

  protected continueInTerminalDisabledReason(row: GatewaySessionRow): string | undefined {
    const gateway = this.context.gateway;
    const client = gateway.snapshot.client;
    if (gateway.snapshot.phase !== "connected" || !client) {
      return t("chat.sessionHeader.continueInTerminal.disconnected");
    }
    const result = this.resolveContinueInTerminalCommand(row, client);
    if (result.ok) {
      return undefined;
    }
    return t(
      result.reason === "query-routed"
        ? "chat.sessionHeader.continueInTerminal.queryRouted"
        : "chat.sessionHeader.continueInTerminal.unavailable",
    );
  }

  private openContinueInTerminalDialog(row: GatewaySessionRow): void {
    const scope = this.captureConnectionScope();
    if (!scope) {
      return;
    }
    const result = this.resolveContinueInTerminalCommand(row, scope.client);
    if (!result.ok) {
      return;
    }
    this.continueInTerminalDialog = {
      qualifiedSessionKey: result.qualifiedSessionKey,
      selectedGatewayUrl: this.context.gateway.connection.gatewayUrl,
      clientGatewayUrl: scope.client.gatewayUrl,
      scope,
    };
    this.requestUpdate();
  }

  protected closeContinueInTerminalDialog(): void {
    if (!this.continueInTerminalDialog) {
      return;
    }
    this.continueInTerminalDialog = null;
    this.requestUpdate();
  }

  protected currentContinueInTerminalCommand(row: GatewaySessionRow | undefined): string | null {
    const dialog = this.continueInTerminalDialog;
    const gateway = this.context.gateway;
    const client = gateway.snapshot.client;
    if (!dialog) {
      return null;
    }
    const result = row && client ? this.resolveContinueInTerminalCommand(row, client) : null;
    if (
      !this.isConnectionScopeCurrent(dialog.scope) ||
      !result?.ok ||
      result.qualifiedSessionKey !== dialog.qualifiedSessionKey ||
      gateway.connection.gatewayUrl !== dialog.selectedGatewayUrl ||
      client?.gatewayUrl !== dialog.clientGatewayUrl
    ) {
      this.continueInTerminalDialog = null;
      return null;
    }
    return result.command;
  }

  private captureHeaderSessionActionScope(): SidebarSessionMutationScope | null {
    const gateway = this.context.gateway;
    const client = gateway.snapshot.client;
    if (gateway.snapshot.phase !== "connected" || !client) {
      return null;
    }
    return {
      epoch: this.connectionGeneration,
      context: this.context,
      gateway,
      sessions: this.context.sessions,
      client,
      selectedAgentId: this.context.agentSelection.state.selectedId ?? "main",
      signal: this.headerSessionMutationAbortController.signal,
    };
  }

  private isHeaderSessionActionCurrent(scope: SidebarSessionMutationScope, owner: string): boolean {
    return (
      this.ownsHeaderOutcome(owner) &&
      this.isConnected &&
      this.context === scope.context &&
      this.context.gateway === scope.gateway &&
      this.context.sessions === scope.sessions &&
      scope.gateway.snapshot.phase === "connected" &&
      scope.gateway.snapshot.client === scope.client
    );
  }

  protected beginHeaderRename(row: GatewaySessionRow): void {
    const access = readSessionMethodAccess(this.context.gateway.snapshot, {
      method: "sessions.patch",
      params: { key: row.key, label: null },
    });
    if (!access.allowed) {
      this.publishHeaderError(access.reason);
      return;
    }
    const customLabel = row.label?.trim() || null;
    this.headerRenameSessionKey = row.key;
    this.headerRenameInitialLabel = customLabel;
    this.headerRenameInitialValue = customLabel ?? this.paneTitle;
    this.headerRenameValue = this.headerRenameInitialValue;
    this.headerEditing = true;
    void this.updateComplete.then(() => {
      const input = this.querySelector<HTMLInputElement>(".chat-pane__session-title-input");
      input?.focus();
      input?.select();
    });
  }

  protected cancelHeaderRename(): void {
    this.headerEditing = false;
    this.headerRenameSessionKey = "";
  }

  protected commitHeaderRename(): void {
    if (!this.headerEditing) {
      return;
    }
    const key = this.headerRenameSessionKey;
    const trimmed = this.headerRenameValue.trim();
    const label = trimmed || null;
    const unchangedDerivedTitle =
      this.headerRenameInitialLabel === null && trimmed === this.headerRenameInitialValue.trim();
    const unchangedLabel = label === this.headerRenameInitialLabel;
    this.headerEditing = false;
    this.headerRenameSessionKey = "";
    const state = this.state;
    if (!key || !state || unchangedDerivedTitle || unchangedLabel) {
      return;
    }
    const access = readSessionMethodAccess(this.context.gateway.snapshot, {
      method: "sessions.patch",
      params: { key, label },
    });
    if (!access.allowed) {
      this.publishHeaderError(access.reason);
      return;
    }
    const owner = this.headerOutcomeOwner;
    void patchChatSessionLabel(state, this.context.sessions, key, label).catch((error: unknown) =>
      this.publishHeaderError(error, owner),
    );
  }

  protected async loadHeaderMenuData(
    row: GatewaySessionRow,
    agentWorkspace: string | undefined,
    workspaceGit: boolean,
  ): Promise<void> {
    const client = this.connectedClient;
    if (!client) {
      return;
    }
    const loads: Promise<void>[] = [];
    // Same precedence as resolveChatPaneWorkspace/loadSessionFileRoot.
    const immediateRoot =
      (row.execNode ? row.execCwd?.trim() : undefined) ||
      row.spawnedWorkspaceDir?.trim() ||
      row.spawnedCwd?.trim() ||
      null;
    const worktreeId = row.worktree?.id;
    if (worktreeId && !immediateRoot) {
      const entry = this.headerWorktreePaths.get(worktreeId) ?? {};
      this.headerWorktreePaths.set(worktreeId, entry);
      if (!entry.loaded && !entry.loading) {
        entry.loading = true;
        loads.push(
          client
            .request<WorktreesListResult>("worktrees.list", {})
            .then((result) => {
              entry.path =
                result.worktrees.find(
                  (candidate) => candidate.id === worktreeId && candidate.removedAt === undefined,
                )?.path ?? null;
              entry.loaded = true;
            })
            .catch(() => {
              entry.path = null;
              entry.loaded = false;
            })
            .finally(() => {
              entry.loading = false;
            }),
        );
      }
    }
    const agentRoot = !row.worktree ? agentWorkspace?.trim() : undefined;
    const knownRoot =
      immediateRoot ||
      (worktreeId ? this.headerWorktreePaths.get(worktreeId)?.path : undefined) ||
      agentRoot;
    const remote = Boolean(row.execNode) || isCloudWorkerPlacementState(row.placement?.state);
    // workspaceGit describes the agent workspace only; a session-specific
    // root (spawned dir) may be a Git checkout regardless.
    const rootMayHaveBranch = knownRoot === agentRoot ? workspaceGit : Boolean(knownRoot);
    // HEAD can move mid-session, so refetch on every open while keeping the
    // last-known branch visible during the refresh to avoid menu flicker.
    if (!row.worktree && !remote && knownRoot && rootMayHaveBranch) {
      const entry = this.headerBranches.get(knownRoot) ?? {};
      this.headerBranches.set(knownRoot, entry);
      if (!entry.loading) {
        entry.loading = true;
        loads.push(
          client
            .request<WorktreesBranchesResult>("worktrees.branches", { repoRoot: knownRoot })
            .then((result) => {
              entry.value = result.headBranch ?? null;
            })
            .catch(() => {
              entry.value = null;
            })
            .finally(() => {
              entry.loading = false;
            }),
        );
      }
    }
    await Promise.all(loads);
    this.requestUpdate();
  }

  protected showHeaderCopied(action: ChatPaneHeaderAction): void {
    this.headerCopiedAction = action;
    if (this.headerCopiedTimer !== null) {
      window.clearTimeout(this.headerCopiedTimer);
    }
    this.headerCopiedTimer = window.setTimeout(() => {
      this.headerCopiedAction = null;
      this.headerCopiedTimer = null;
    }, 1_500);
  }

  protected handleHeaderMenuAction(
    action: ChatPaneHeaderAction,
    row: GatewaySessionRow,
    workspaceRoot: string | null,
    branch: string | null,
    copy: (value: string) => Promise<boolean> = copyToClipboard,
  ): void {
    const copiedValue =
      action === "copy-path" ? workspaceRoot : action === "copy-branch" ? branch : null;
    if (copiedValue) {
      const owner = this.headerOutcomeOwner;
      void copy(copiedValue).then((copied) => {
        if (!this.ownsHeaderOutcome(owner)) {
          return;
        }
        if (copied) {
          this.showHeaderCopied(action);
        } else {
          this.publishHeaderError(t("common.copyFailed"), owner);
        }
      });
      return;
    }
    if (action === "reveal" && workspaceRoot) {
      void this.revealHeaderWorkspace(row);
    }
  }

  protected publishHeaderError(error: unknown, owner = this.headerOutcomeOwner): void {
    if (!this.state || !this.ownsHeaderOutcome(owner)) {
      return;
    }
    this.state.chatError = this.state.lastError =
      error instanceof Error ? error.message : String(error);
    this.state.requestUpdate?.();
  }

  protected async revealHeaderWorkspace(row: GatewaySessionRow): Promise<void> {
    const client = this.connectedClient;
    if (!client) {
      return;
    }
    const owner = this.headerOutcomeOwner;
    const agentId = parseAgentSessionKey(row.key)?.agentId;
    try {
      const result = await client.request<SessionsFilesRevealResult>("sessions.files.reveal", {
        key: row.key,
        ...(agentId ? { agentId } : {}),
      });
      if (!result.ok) {
        const error = result.error ?? "Failed to reveal session workspace.";
        this.publishHeaderError(error, owner);
      }
    } catch (error) {
      this.publishHeaderError(error, owner);
    }
  }
}
