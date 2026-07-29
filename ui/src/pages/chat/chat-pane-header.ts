import { html, nothing } from "lit";
import type {
  SessionDiscussionInfo,
  SessionDiscussionState,
  SessionsFilesRevealResult,
  SystemInfoResult,
  WorktreesBranchesResult,
  WorktreesListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { hasOperatorWriteAccess, hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { readPresenceEntries, resolveActorIdentityUsers } from "../../app/user-profile.ts";
import { icons } from "../../components/icons.ts";
import { listSessionCreators } from "../../components/session-owner-chip.ts";
import { isCloudWorkerPlacementState } from "../../components/session-row-badges.ts";
import { hasSessionPresenceViewers } from "../../components/viewer-facepile.ts";
import { t } from "../../i18n/index.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { renderBoardDockMenu, renderBoardFaceToggle } from "./board-session-surface.ts";
import { ChatPaneContext } from "./chat-pane-context.ts";
import { headerPlatformByClient } from "./chat-pane-shared.ts";
import { renderCatalogTerminalButton } from "./components/catalog-terminal-button.ts";
import {
  renderBackgroundTasksToggle,
  type BackgroundTasksProps,
} from "./components/chat-background-tasks.ts";
import { isChatRunWorking } from "./components/chat-composer.ts";
import {
  type ChatPaneHeaderAction,
  canRevealSessionWorkspace,
  renderChatPaneHeader,
  resolveChatPaneWorkspace,
} from "./components/chat-pane-header.ts";
import { renderChatSessionSharing } from "./components/chat-session-sharing.ts";
import {
  renderSessionDiffToggle,
  renderSessionWorkspaceToggle,
  type SessionWorkspaceProps,
} from "./components/chat-session-workspace.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.ts";
import { hasAbortableSessionRun } from "./run-lifecycle.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  activatePanel,
  closeSlot,
  fitSidebarLayout,
  openSlot,
} from "./sidebar-layout.ts";

export abstract class ChatPaneHeader extends ChatPaneContext {
  protected renderPaneHeader(
    sessionWorkspace: SessionWorkspaceProps,
    backgroundTasks: BackgroundTasksProps,
    row: GatewaySessionRow | undefined,
    catalog: boolean,
    agentWorkspace: string | undefined,
    workspaceGit: boolean,
  ) {
    const board = this.resolveBoardView();
    const workspace = resolveChatPaneWorkspace({
      session: row,
      agentWorkspace: row?.worktree ? undefined : agentWorkspace,
      worktreePath: row?.worktree ? this.headerWorktreePaths.get(row.worktree.id)?.path : undefined,
    });
    // Managed worktree sessions copy the worktree record's branch — the same
    // source the sidebar subtitle and preserved-worktree prompts use. Live
    // HEAD is only resolved for plain checkouts, where no record exists.
    // Cached HEAD is keyed by the resolved root and masked while the session
    // runs remotely, so reused keys, root transitions, open menus, and
    // in-flight lookups racing a dispatch can never surface a wrong branch.
    const rowRemote = Boolean(row?.execNode) || isCloudWorkerPlacementState(row?.placement?.state);
    const branch =
      row?.worktree?.branch ||
      (rowRemote || !workspace.root ? null : this.headerBranches.get(workspace.root)?.value) ||
      null;
    const canReveal = canRevealSessionWorkspace({
      session: row,
      workspaceRoot: workspace.root,
      methodAdvertised:
        isGatewayMethodAdvertised(this.context.gateway.snapshot, "sessions.files.reveal") === true,
      hasAdminAccess: hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null),
    });
    const branchSwitchWorking = this.state
      ? this.state.chatSending ||
        isChatRunWorking({
          canAbort: hasAbortableSessionRun(this.state),
          onAbort: () => undefined,
          queue: this.state.chatQueue,
          runStatus: this.state.chatRunStatus,
          sessionKey: this.state.sessionKey,
        })
      : false;
    const branchSwitchDisabledReason = !hasOperatorAdminAccess(
      this.context.gateway.snapshot.hello?.auth ?? null,
    )
      ? t("chat.sessionHeader.branchSwitchRequiresAdmin")
      : branchSwitchWorking
        ? t("chat.sessionHeader.branchSwitchUnavailable")
        : null;
    const ownerActorId = row?.createdActor?.id?.trim();
    const ownerUser = ownerActorId
      ? resolveActorIdentityUsers({
          snapshotUser: this.context.gateway.snapshot.selfUser,
          presenceEntries: readPresenceEntries(this.presencePayload),
          presenceInstanceId: this.context.gateway.snapshot.client?.instanceId,
        }).get(ownerActorId)
      : undefined;
    return renderChatPaneHeader({
      paneId: this.paneId,
      narrow: this.narrow,
      mergedChrome: this.mergedChrome,
      navDrawerOpen: this.navDrawerOpen,
      title: this.paneTitle,
      session: row,
      showOwnerChip:
        (
          this.state?.sessionsResult?.creators ??
          listSessionCreators(this.state?.sessionsResult?.sessions ?? [])
        ).length >= 2,
      ownerUser,
      catalog,
      editing: this.headerEditing && this.headerRenameSessionKey === row?.key,
      renameValue: this.headerRenameValue,
      workspaceRoot: workspace.root,
      workspaceLabel: workspace.label,
      branch,
      branches:
        this.state && this.state.chatBranchesSessionKey === this.state.sessionKey
          ? (this.state.chatBranches ?? [])
          : [],
      branchSwitchDisabledReason,
      platform: this.headerPlatform,
      canReveal,
      copiedAction: this.headerCopiedAction,
      canRename:
        this.state?.connected === true &&
        hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null),
      terminalAction: renderCatalogTerminalButton(this.state, this.catalogSession),
      discussionAction: this.renderSessionDiscussionAction(),
      diffAction: renderSessionDiffToggle(sessionWorkspace),
      backgroundTasksAction: renderBackgroundTasksToggle(backgroundTasks),
      workspaceAction: renderSessionWorkspaceToggle(sessionWorkspace),
      presence:
        !catalog &&
        hasSessionPresenceViewers(
          this.presencePayload,
          this.context.gateway.snapshot.client?.instanceId,
          this.state?.sessionKey ?? "",
        )
          ? html`<openclaw-viewer-facepile
              class="chat-pane__presence"
              .presencePayload=${this.presencePayload}
              .selfInstanceId=${this.context.gateway.snapshot.client?.instanceId}
              .sessionKey=${this.state?.sessionKey}
              .maxVisible=${4}
              variant="session"
            ></openclaw-viewer-facepile>`
          : nothing,
      faceControl: renderBoardFaceToggle(board.hasBoard, board.face, (face) => {
        this.syncChatSidebarForDock(face === "dashboard" ? board.dock : "hidden");
        this.persistBoardSessionView({ face });
      }),
      sharingControl:
        isGatewayMethodAdvertised(this.context.gateway.snapshot, "session.visibility.set") === true
          ? renderChatSessionSharing({
              session: row,
              state: row
                ? this.sessionSharingStates.get(this.sessionSharingCacheKey(row.key))
                : undefined,
              onOpen: () => row && void this.loadSessionSharing(row),
              onVisibilityChange: (visibility) =>
                row && void this.setSessionVisibility(row, visibility),
              onMemberChange: (identityId, member) =>
                row && void this.setSessionMember(row, identityId, member),
            })
          : nothing,
      boardDockAction: renderBoardDockMenu(
        board.hasBoard && !board.activeTabReadOnly && board.provider.canMutate,
        board.face,
        board.dock,
        (dock) => this.handleBoardDockChange(dock),
      ),
      nativeGateways: this.nativeGateways,
      gatewaysSnapshot: this.gatewaysSnapshot,
      onboarding: this.onboarding,
      onBeginRename: () => row && this.beginHeaderRename(row),
      onRenameInput: (value) => {
        this.headerRenameValue = value;
      },
      onCommitRename: () => this.commitHeaderRename(),
      onCancelRename: () => this.cancelHeaderRename(),
      onMenuOpenChange: (open) => {
        if (open && row) {
          void this.loadHeaderMenuData(row, agentWorkspace, workspaceGit);
        }
      },
      onMenuAction: (action) => {
        if (row) {
          this.handleHeaderMenuAction(action, row, workspace.root, branch);
        }
      },
      onBranchSelect: (leafEntryId) => void this.switchToBranch(leafEntryId),
      onOpenSplitView: this.onOpenSplitView,
      onSplitDown: this.onSplitDown,
      onSplitRight: this.onSplitRight,
      onClosePane: this.onClosePane,
    });
  }

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

  protected beginHeaderRename(row: GatewaySessionRow): void {
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
    if (!key || unchangedDerivedTitle || unchangedLabel) {
      return;
    }
    const agentId = parseAgentSessionKey(key)?.agentId;
    void this.context.sessions
      .patch(key, { label }, agentId ? { agentId } : undefined)
      .catch((error: unknown) => this.publishHeaderError(error));
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
    // root (spawned dir) may be a Git checkout regardless, so probe it and
    // let a failed lookup hide the branch action instead.
    const rootMayHaveBranch = knownRoot === agentRoot ? workspaceGit : Boolean(knownRoot);
    // Unlike the worktree path, HEAD moves whenever the agent checks out a
    // branch mid-session, so every menu open refetches. Deliberate
    // stale-while-revalidate: the last-known branch stays actionable during
    // the sub-second local refresh — hiding it would flicker the menu on
    // every open to guard a race narrower than the user's click.
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
    if (action === "copy-path" && workspaceRoot) {
      void copy(workspaceRoot).then((copied) => {
        if (copied) {
          this.showHeaderCopied(action);
        }
      });
      return;
    }
    if (action === "copy-branch" && branch) {
      void copy(branch).then((copied) => {
        if (copied) {
          this.showHeaderCopied(action);
        }
      });
      return;
    }
    if (action === "reveal" && workspaceRoot) {
      void this.revealHeaderWorkspace(row);
    }
  }

  protected publishHeaderError(error: unknown): void {
    if (!this.state) {
      return;
    }
    this.state.chatError = error instanceof Error ? error.message : String(error);
    this.state.requestUpdate?.();
  }

  protected async revealHeaderWorkspace(row: GatewaySessionRow): Promise<void> {
    const client = this.connectedClient;
    if (!client) {
      return;
    }
    const agentId = parseAgentSessionKey(row.key)?.agentId;
    try {
      const result = await client.request<SessionsFilesRevealResult>("sessions.files.reveal", {
        key: row.key,
        ...(agentId ? { agentId } : {}),
      });
      if (!result.ok) {
        this.publishHeaderError(result.error ?? "Failed to reveal thread workspace.");
      }
    } catch (error) {
      this.publishHeaderError(error);
    }
  }

  // Probe once per session activation; transient failures stay uncached so the
  // next activation retries instead of permanently hiding the feature.
  protected async probeSessionDiscussion(sessionKey: string) {
    const state = this.state;
    if (
      !state?.connected ||
      !state.client ||
      this.sessionDiscussionStates.has(sessionKey) ||
      // One in-flight probe per key: a rapid A→B→A switch must not start a
      // second probe whose slower twin could later overwrite the fresh result.
      this.sessionDiscussionProbes.has(sessionKey) ||
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "session.discussion.info") !== true
    ) {
      return;
    }
    const generation = this.connectionGeneration;
    this.sessionDiscussionProbes.add(sessionKey);
    try {
      const info = await state.client.request<SessionDiscussionInfo>("session.discussion.info", {
        sessionKey,
      });
      // A reconnect supersedes in-flight probes; a stale result must not
      // overwrite the new source's cache (e.g. an old "none" hiding the action).
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.sessionDiscussionStates.set(sessionKey, info.state);
      this.maybeAutoShowSessionDiscussion(sessionKey, info.state);
      this.requestUpdate();
    } catch {
      // Leave unprobed: the action stays hidden and a later switch retries.
    } finally {
      this.sessionDiscussionProbes.delete(sessionKey);
      // A reconnect during this probe skipped its own probe (the key was
      // still held here); retry now so the new source gets a fresh answer.
      if (
        generation !== this.connectionGeneration &&
        this.state?.sessionKey === sessionKey &&
        !this.sessionDiscussionStates.has(sessionKey)
      ) {
        void this.probeSessionDiscussion(sessionKey);
      }
    }
  }

  // An "open" probe result means this session already has a bound discussion;
  // surface it immediately instead of hiding live chat behind the toggle.
  // Probe resolution is the only hook needed: willUpdate deletes the target
  // key's cached state on every session switch (and reconnect clears all), so
  // each activation resolves a fresh probe and reaches this. Within one
  // activation the cache dedupes — closing the sidebar sticks, and an
  // already-open discussion column is never duplicated.
  protected maybeAutoShowSessionDiscussion(
    sessionKey: string,
    discussionState: SessionDiscussionState,
  ) {
    const state = this.state;
    if (
      discussionState !== "open" ||
      !state ||
      state.sessionKey.trim() !== sessionKey ||
      state.sidebarLayout.columns.some((column) =>
        column.panels.some((panel) => panel.slot === "discussion"),
      )
    ) {
      return;
    }
    this.openSessionDiscussionSlot();
  }

  protected buildSessionDiscussionPanel(
    state: NonNullable<typeof this.state>,
    sessionKey: string,
  ): SessionDiscussionPanelConfig | null {
    if (!state.connected || !state.client) {
      return null;
    }
    const canOpen =
      hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "session.discussion.open") === true;
    const contentGeneration = this.connectionGeneration;
    const cached = this.sessionDiscussionPanels.get(sessionKey);
    if (cached?.generation === contentGeneration && cached.canOpen === canOpen) {
      cached.config.openUrl = this.sessionDiscussionOpenUrls.get(sessionKey) ?? null;
      return cached.config;
    }
    const config: SessionDiscussionPanelConfig = {
      sessionKey,
      canOpen,
      openUrl: this.sessionDiscussionOpenUrls.get(sessionKey) ?? null,
      loadInfo: async (key) => {
        if (!state.connected || !state.client) {
          throw new Error(t("chat.sessionDiscussion.disconnected"));
        }
        return await state.client.request<SessionDiscussionInfo>("session.discussion.info", {
          sessionKey: key,
        });
      },
      openDiscussion: async (key) => {
        if (!state.connected || !state.client) {
          throw new Error(t("chat.sessionDiscussion.disconnected"));
        }
        return await state.client.request<SessionDiscussionInfo>("session.discussion.open", {
          sessionKey: key,
        });
      },
      onStateChange: (key, discussionState, openUrl) => {
        // Panels created under a previous connection may report late; their
        // state belongs to the old provider and must not touch the new cache.
        if (contentGeneration !== this.connectionGeneration) {
          return;
        }
        this.sessionDiscussionStates.set(key, discussionState);
        const isCurrentSession = state.sessionKey.trim() === key;
        if (isCurrentSession) {
          this.sessionDiscussionOpenUrls.set(key, openUrl);
        }
        if (discussionState === "none") {
          this.sessionDiscussionOpenUrls.delete(key);
        }
        if (discussionState === "none" && isCurrentSession) {
          state.updateSidebarLayout(closeSlot(state.sidebarLayout, "discussion"));
          return;
        }
        state.requestUpdate();
      },
    };
    this.sessionDiscussionPanels.set(sessionKey, {
      generation: contentGeneration,
      canOpen,
      config,
    });
    return config;
  }

  protected openSessionDiscussionSlot(): boolean {
    const state = this.state;
    if (!state) {
      return false;
    }
    let opened = openSlot(state.sidebarLayout, "discussion", "right");
    const discussionPanel = opened.columns
      .flatMap((column) => column.panels)
      .find((panel) => panel.slot === "discussion");
    if (discussionPanel) {
      opened = activatePanel(opened, discussionPanel.id);
    }
    const newColumn = opened.columns.find(
      (column) => !state.sidebarLayout.columns.some((current) => current.id === column.id),
    );
    const fitted =
      this.paneWidth >= SIDEBAR_NARROW_BREAKPOINT_PX
        ? (fitSidebarLayout(opened, this.paneWidth, newColumn?.id) ?? opened)
        : opened;
    state.updateSidebarLayout(fitted);
    if (discussionPanel) {
      state.updateSidebarActivePanel(discussionPanel.id);
    }
    return true;
  }

  protected renderSessionDiscussionAction() {
    const state = this.state;
    const sessionKey = state?.sessionKey.trim() ?? "";
    const known = sessionKey ? this.sessionDiscussionStates.get(sessionKey) : undefined;
    if (
      !state?.connected ||
      !state.client ||
      !sessionKey ||
      known === undefined ||
      known === "none" ||
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "session.discussion.info") !== true
    ) {
      return nothing;
    }
    if (!this.buildSessionDiscussionPanel(state, sessionKey)) {
      return nothing;
    }
    const active = state.sidebarLayout.columns.some((column) =>
      column.panels.some((panel) => panel.slot === "discussion"),
    );
    const label = t(active ? "chat.sessionDiscussion.hide" : "chat.sessionDiscussion.show");
    return html`
      <openclaw-tooltip .content=${label}>
        <button
          class="btn btn--ghost btn--icon chat-icon-btn chat-session-discussion-toggle"
          type="button"
          aria-label=${label}
          aria-pressed=${String(active)}
          @click=${() =>
            active
              ? state.updateSidebarLayout(closeSlot(state.sidebarLayout, "discussion"))
              : this.openSessionDiscussionSlot()}
        >
          ${icons.messageSquare}
        </button>
      </openclaw-tooltip>
    `;
  }
}
