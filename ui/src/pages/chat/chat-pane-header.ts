import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing } from "lit";
import type { SessionDiscussionInfo } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { isDesktopPanelAvailable } from "../../app/app-shell-chrome.ts";
import { resolveControlUiAuthCandidates } from "../../app/control-ui-auth.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { icons } from "../../components/icons.ts";
import {
  DESKTOP_PANEL_TOGGLE_EVENT,
  type DesktopPanelToggleDetail,
} from "../../components/panel-toggle-contract.ts";
import { sessionMenuReasons } from "../../components/session-menu-access.ts";
import { listSessionCreators } from "../../components/session-owner-chip.ts";
import { isCloudWorkerPlacementState } from "../../components/session-row-badges.ts";
import { hasSessionPresenceViewers } from "../../components/viewer-facepile.ts";
import { workspaceIconRouteUrl } from "../../components/workspace-icon.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import {
  canArchiveSessionRow,
  canDeleteSessionRows,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { isActiveTask } from "../../lib/tasks/data.ts";
import { renderBoardViewSwitch } from "./board-session-surface.ts";
import { resolveChatPaneDesktopTarget, resolveChatPanePlacement } from "./chat-pane-placement.ts";
import { ChatPaneSessionMenu } from "./chat-pane-session-menu.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import { resolveChatAgentId } from "./chat-state-route.ts";
import { renderBackgroundTasksToggle } from "./components/chat-background-tasks-render.ts";
import type { BackgroundTasksProps } from "./components/chat-background-tasks.types.ts";
import { isChatRunWorking } from "./components/chat-composer.ts";
import "./components/chat-header-session-menu.ts";
import type {
  HeaderMenuAction,
  HeaderMenuActionKind,
  HeaderMenuQuickAction,
} from "./components/chat-header-session-menu.ts";
import {
  canRevealSessionWorkspace,
  renderChatPaneHeader,
  resolveChatPaneParentSession,
  resolveChatPaneWorkspace,
} from "./components/chat-pane-header.ts";
import { renderSessionRailToggle } from "./components/chat-session-rail-toggle.ts";
import { renderChatSessionSharing } from "./components/chat-session-sharing.ts";
import {
  renderSessionDiffToggle,
  renderSessionWorkspaceToggle,
  type SessionWorkspaceProps,
} from "./components/chat-session-workspace.ts";
import { renderChatTerminalButton } from "./components/chat-terminal-button.ts";
import { renderContinueInTerminalDialog } from "./components/continue-in-terminal-dialog.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.ts";
import { hasAbortableSessionRun } from "./run-lifecycle.ts";
import {
  SIDEBAR_NARROW_BREAKPOINT_PX,
  activatePanel,
  closeSlot,
  fitSidebarLayout,
  openSlot,
} from "./sidebar-layout.ts";

export abstract class ChatPaneHeader extends ChatPaneSessionMenu {
  /** Gateway-served project icon for a session workspace, on the same credentials as agent avatars. */
  private resolveWorkspaceIcon(sessionKey: string | undefined) {
    if (!sessionKey) {
      return null;
    }
    const gateway = this.context.gateway;
    const authTokens = resolveControlUiAuthCandidates({
      hello: gateway.snapshot.hello,
      settings: { token: gateway.connection.token },
      password: gateway.connection.password,
    });
    return {
      routeUrl: workspaceIconRouteUrl(this.context.basePath, sessionKey),
      authTokens,
      authReady: Boolean(gateway.snapshot.hello || authTokens.length),
    };
  }

  protected renderPaneHeader(
    sessionWorkspace: SessionWorkspaceProps,
    backgroundTasks: BackgroundTasksProps,
    row: GatewaySessionRow | undefined,
    catalog: boolean,
    agentWorkspace: string | undefined,
    workspaceGit: boolean,
  ) {
    const board = this.resolveBoardView();
    const canChangeBoardDock = board.hasBoard && board.provider.canMutate;
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
    const branchSwitchAccess = readChatSessionActionAccess(
      this.context.gateway.snapshot,
      Boolean(this.state?.chatRunId),
    ).branchSwitch;
    const branchSwitchDisabledReason = !branchSwitchAccess.allowed
      ? branchSwitchAccess.reason
      : branchSwitchWorking
        ? t("chat.sessionHeader.branchSwitchUnavailable")
        : null;
    const sharingSnapshot = this.context.gateway.snapshot;
    // Sharing was introduced behind this advertised method. Keep the control
    // hidden for older Gateways that omit method metadata.
    const sharingMethodsSupported =
      isGatewayMethodAdvertised(sharingSnapshot, "session.visibility.set") === true;
    const sharingReadAccess = readSessionMethodAccess(sharingSnapshot, {
      method: "session.members.list",
      requiredScope: "operator.read",
    });
    const sharingVisibilityAccess = readSessionMethodAccess(sharingSnapshot, {
      method: "session.visibility.set",
      requiredScope: "operator.write",
    });
    const sharingMemberAddAccess = readSessionMethodAccess(sharingSnapshot, {
      method: "session.members.add",
      requiredScope: "operator.write",
    });
    const sharingMemberRemoveAccess = readSessionMethodAccess(sharingSnapshot, {
      method: "session.members.remove",
      requiredScope: "operator.write",
    });
    const sharingOpenDisabledReason =
      sharingReadAccess.allowed || sharingVisibilityAccess.allowed
        ? undefined
        : sharingReadAccess.reason;
    const renameAccess = row
      ? readSessionMethodAccess(this.context.gateway.snapshot, {
          method: "sessions.patch",
          params: { key: row.key, label: null },
        })
      : null;
    const renameDisabledReason =
      this.state?.connected !== true || !renameAccess
        ? t("sessionsView.actionRequiresConnection")
        : renameAccess.allowed
          ? undefined
          : renameAccess.reason;
    const configuredMainKey = resolveUiConfiguredMainKey({
      agentsList: this.context.agents.state.agentsList,
      hello: this.context.gateway.snapshot.hello,
    });
    const archiveAllowed = Boolean(row && canArchiveSessionRow(row, configuredMainKey));
    const deleteAllowed = Boolean(row && canDeleteSessionRows([row], configuredMainKey));
    const sessionActionDisabledReasons = row
      ? sessionMenuReasons({
          snapshot: this.context.gateway.snapshot,
          session: row,
        })
      : {};
    const continueInTerminalDisabledReason = row
      ? this.continueInTerminalDisabledReason(row)
      : undefined;
    const actionDisabledReasons: Partial<Record<HeaderMenuActionKind, string>> = {
      ...sessionActionDisabledReasons,
      ...(continueInTerminalDisabledReason
        ? { "continue-in-terminal": continueInTerminalDisabledReason }
        : {}),
    };
    const desktopEnvironmentId = resolveChatPaneDesktopTarget(row);
    const desktopPanelAvailable =
      desktopEnvironmentId !== null && isDesktopPanelAvailable(this.context.gateway.snapshot);
    const openDesktopPanel = () => {
      if (!desktopEnvironmentId) {
        return;
      }
      window.dispatchEvent(
        new CustomEvent<DesktopPanelToggleDetail>(DESKTOP_PANEL_TOGGLE_EVENT, {
          detail: { open: true, environmentId: desktopEnvironmentId },
        }),
      );
    };
    const browserPanelAction = sessionWorkspace.onToggleBrowser
      ? html`<openclaw-tooltip .content=${t("browser.toggle")}>
          <button
            class="btn btn--ghost btn--icon chat-icon-btn chat-browser-panel-toggle"
            type="button"
            aria-label=${t("browser.toggle")}
            @click=${sessionWorkspace.onToggleBrowser}
          >
            ${icons.globe}
          </button>
        </openclaw-tooltip>`
      : nothing;
    const desktopPanelAction = desktopPanelAvailable
      ? html`<openclaw-tooltip .content=${t("desktop.toggle")}>
          <button
            class="btn btn--ghost btn--icon chat-icon-btn chat-desktop-panel-toggle"
            type="button"
            aria-label=${t("desktop.toggle")}
            @click=${openDesktopPanel}
          >
            ${icons.monitor}
          </button>
        </openclaw-tooltip>`
      : nothing;
    const discussion = this.resolveSessionDiscussionAction();
    const sessionRailMode = this.selectedSessionRailMode(this.state?.sessionKey ?? "");
    const toggleSessionRail = () => this.requestSessionRail("toggle");
    const panelMenuActions: HeaderMenuQuickAction[] = [];
    if (sessionWorkspace.onToggleTerminal) {
      panelMenuActions.push({
        id: "terminal",
        label: t("terminal.toggle"),
        icon: icons.terminal,
        onActivate: sessionWorkspace.onToggleTerminal,
      });
    }
    if (sessionWorkspace.onToggleBrowser) {
      panelMenuActions.push({
        id: "browser",
        label: t("browser.toggle"),
        icon: icons.globe,
        onActivate: sessionWorkspace.onToggleBrowser,
      });
    }
    if (desktopPanelAvailable) {
      panelMenuActions.push({
        id: "desktop",
        label: t("desktop.toggle"),
        icon: icons.monitor,
        onActivate: openDesktopPanel,
      });
    }
    if (discussion) {
      panelMenuActions.push({
        id: "discussion",
        label: discussion.label,
        icon: icons.messageSquare,
        active: discussion.active,
        onActivate: discussion.onToggle,
      });
    }
    if (sessionWorkspace.onOpenDiff) {
      panelMenuActions.push({
        id: "changes",
        label: t("chat.sessionDiff.show"),
        icon: icons.diff,
        onActivate: sessionWorkspace.onOpenDiff,
      });
    }
    if (backgroundTasks) {
      panelMenuActions.push({
        id: "background-tasks",
        label: t(
          backgroundTasks.collapsed ? "chat.backgroundTasks.show" : "chat.backgroundTasks.collapse",
        ),
        icon: icons.listChecks,
        active: !backgroundTasks.collapsed,
        badge: backgroundTasks.tasks?.filter(isActiveTask).length ?? 0,
        onActivate: backgroundTasks.onToggleCollapsed,
      });
    }
    panelMenuActions.push({
      id: "session-files",
      label: t(
        sessionWorkspace.collapsed
          ? "chat.workspaceFiles.showFiles"
          : "chat.workspaceFiles.collapse",
      ),
      icon: icons.fileText,
      active: !sessionWorkspace.collapsed,
      badge: sessionWorkspace.list?.files.filter((file) => file.kind === "modified").length ?? 0,
      onActivate: sessionWorkspace.onToggleCollapsed,
    });
    panelMenuActions.push({
      id: "session-companion",
      label: t(sessionRailMode === "expanded" ? "chat.rail.collapse" : "chat.rail.show"),
      icon: icons.spark,
      active: sessionRailMode === "expanded",
      onActivate: toggleSessionRail,
    });
    const layoutMenuActions: HeaderMenuQuickAction[] = [];
    if (this.onOpenSplitView) {
      layoutMenuActions.push({
        id: "open-split-view",
        label: t("chat.splitView.open"),
        icon: icons.columns2,
        onActivate: this.onOpenSplitView,
      });
    }
    if (!this.narrow && this.onSplitDown) {
      layoutMenuActions.push({
        id: "split-down",
        label: t("chat.splitView.splitDown"),
        icon: icons.panelBottomOpen,
        onActivate: () => this.onSplitDown?.(this.paneId),
      });
    }
    if (!this.narrow && this.onSplitRight) {
      layoutMenuActions.push({
        id: "split-right",
        label: t("chat.splitView.splitRight"),
        icon: icons.panelRightOpen,
        onActivate: () => this.onSplitRight?.(this.paneId),
      });
    }
    const placement = resolveChatPanePlacement({
      gatewaySnapshot: this.context.gateway.snapshot,
      reclaimingKey: this.headerPlacementReclaimingKey,
      row,
    });
    const header = renderChatPaneHeader({
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
      catalog,
      editing: this.headerEditing && this.headerRenameSessionKey === row?.key,
      renameValue: this.headerRenameValue,
      workspaceRoot: workspace.root,
      workspaceLabel: workspace.label,
      workspaceIcon: this.resolveWorkspaceIcon(workspace.root ? row?.key : undefined),
      parentSession: resolveChatPaneParentSession(row, this.state?.sessionsResult?.sessions ?? []),
      branch,
      branches:
        this.state && this.state.chatBranchesSessionKey === this.state.sessionKey
          ? (this.state.chatBranches ?? [])
          : [],
      branchSwitchDisabledReason,
      platform: this.headerPlatform,
      canReveal,
      copiedAction: this.headerCopiedAction,
      renameDisabledReason,
      panelActions: html`${renderChatTerminalButton(
        this.state,
        this.catalogSession,
        sessionWorkspace.onToggleTerminal,
      )}${browserPanelAction}${desktopPanelAction}`,
      discussionAction: this.renderSessionDiscussionAction(discussion),
      diffAction: renderSessionDiffToggle(sessionWorkspace),
      backgroundTasksAction: renderBackgroundTasksToggle(backgroundTasks),
      sessionRailAction: renderSessionRailToggle({
        mode: sessionRailMode,
        onToggle: toggleSessionRail,
      }),
      workspaceAction: renderSessionWorkspaceToggle(sessionWorkspace),
      presence:
        !catalog &&
        hasSessionPresenceViewers(
          this.presencePayload,
          this.context.gateway.snapshot.selfUser?.id,
          this.context.gateway.snapshot.client?.instanceId,
          this.state?.sessionKey ?? "",
        )
          ? html`<openclaw-viewer-facepile
              class="chat-pane__presence"
              .presencePayload=${this.presencePayload}
              .selfUserId=${this.context.gateway.snapshot.selfUser?.id}
              .selfInstanceId=${this.context.gateway.snapshot.client?.instanceId}
              .sessionKey=${this.state?.sessionKey}
              .maxVisible=${4}
              variant="session"
            ></openclaw-viewer-facepile>`
          : nothing,
      faceControl: renderBoardViewSwitch({
        hasBoard: board.hasBoard,
        face: board.face,
        dock: board.dock,
        canChangeDock: canChangeBoardDock,
        onSelectMode: (mode) => {
          if (!canChangeBoardDock) {
            const face = mode === "chat" ? "chat" : "dashboard";
            this.syncChatSidebarForDock(face === "dashboard" ? board.dock : "hidden");
            this.persistBoardSessionView({ face });
            return;
          }
          if (mode === "chat") {
            this.syncChatSidebarForDock("hidden");
            this.persistBoardSessionView({ face: "chat" });
            return;
          }
          this.persistBoardSessionView({ face: "dashboard" });
          if (mode === "split") {
            if (board.dock === "hidden") {
              this.handleBoardDockChange(board.reopenDock);
            } else {
              this.syncChatSidebarForDock(board.dock);
            }
          } else if (board.dock !== "hidden") {
            this.handleBoardDockChange("hidden");
          }
        },
        onDockSideChange: (dock) => this.handleBoardDockChange(dock),
      }),
      sharingControl: sharingMethodsSupported
        ? renderChatSessionSharing({
            session: row,
            state: row
              ? this.sessionSharingStates.get(this.sessionSharingCacheKey(row.key))
              : undefined,
            allowedVisibilities: sharingSnapshot.hello?.policy?.allowedSessionVisibilities,
            membersAvailable: sharingReadAccess.allowed,
            openDisabledReason: sharingOpenDisabledReason,
            visibilityDisabledReason: sharingVisibilityAccess.allowed
              ? undefined
              : sharingVisibilityAccess.reason,
            memberAddDisabledReason: sharingMemberAddAccess.allowed
              ? undefined
              : sharingMemberAddAccess.reason,
            memberRemoveDisabledReason: sharingMemberRemoveAccess.allowed
              ? undefined
              : sharingMemberRemoveAccess.reason,
            onOpen: () => row && void this.loadSessionSharing(row),
            onVisibilityChange: (visibility) =>
              row && void this.setSessionVisibility(row, visibility),
            onMemberChange: (identityId, member) =>
              row && void this.setSessionMember(row, identityId, member),
          })
        : nothing,
      sessionMenuAction:
        row && this.state
          ? html`<openclaw-chat-header-session-menu
              .sessionLabel=${normalizeOptionalString(row.label) ??
              normalizeOptionalString(this.paneTitle) ??
              row.key}
              .worktreePath=${row.execNode ? null : workspace.root}
              .archived=${row.archived === true}
              .onboarding=${this.onboarding}
              .preferencesBrowserOnly=${this.context.runtimeConfig?.state.connected &&
              this.context.runtimeConfig.canPatch === false}
              .compact=${this.narrow}
              .settings=${this.state.settings}
              .panelActions=${panelMenuActions}
              .layoutActions=${layoutMenuActions}
              .actionDisabledReasons=${actionDisabledReasons}
              .forkDisabled=${this.state.sessionsLoading || row.modelSelectionLocked === true}
              .archiveAllowed=${archiveAllowed}
              .deleteAllowed=${deleteAllowed}
              .onOpen=${() => {
                void this.loadHeaderMenuData(row, agentWorkspace, workspaceGit);
              }}
              .onSettingsChange=${this.state.applySettings}
              .onAction=${(action: HeaderMenuAction) => this.handleHeaderSessionAction(action, row)}
            ></openclaw-chat-header-session-menu>`
          : nothing,
      placementReclaimDisabledReason: placement.reclaimDisabledReason,
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
      onOpenParentSession: (sessionKey) => {
        this.onPaneSessionChange?.(this.paneId, sessionKey);
      },
      onPlacementReclaim: () => row && void this.reclaimHeaderPlacement(row),
      onBranchSelect: (leafEntryId) => {
        const access = readChatSessionActionAccess(
          this.context.gateway.snapshot,
          Boolean(this.state?.chatRunId),
        ).branchSwitch;
        if (!access.allowed) {
          this.publishHeaderError(access.reason);
          return;
        }
        void this.switchToBranch(leafEntryId);
      },
      onOpenSplitView: this.onOpenSplitView,
      onSplitDown: this.onSplitDown,
      onSplitRight: this.onSplitRight,
      onClosePane: this.onClosePane,
    });
    const continueCommand = this.currentContinueInTerminalCommand(row);
    return html`${header}${continueCommand
      ? renderContinueInTerminalDialog({
          command: continueCommand,
          onClose: () => this.closeContinueInTerminalDialog(),
        })
      : nothing}`;
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
        agentId: resolveChatAgentId(state),
      });
      // A reconnect supersedes in-flight probes; a stale result must not
      // overwrite the new source's cache (e.g. an old "none" hiding the action).
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.sessionDiscussionStates.set(sessionKey, info.state);
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
          agentId: resolveChatAgentId(state),
        });
      },
      openDiscussion: async (key) => {
        if (!state.connected || !state.client) {
          throw new Error(t("chat.sessionDiscussion.disconnected"));
        }
        return await state.client.request<SessionDiscussionInfo>("session.discussion.open", {
          sessionKey: key,
          agentId: resolveChatAgentId(state),
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

  private resolveSessionDiscussionAction(): {
    active: boolean;
    label: string;
    onToggle: () => void;
  } | null {
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
      return null;
    }
    if (!this.buildSessionDiscussionPanel(state, sessionKey)) {
      return null;
    }
    const active = state.sidebarLayout.columns.some((column) =>
      column.panels.some((panel) => panel.slot === "discussion"),
    );
    const label = t(active ? "chat.sessionDiscussion.hide" : "chat.sessionDiscussion.show");
    return {
      active,
      label,
      onToggle: () =>
        active
          ? state.updateSidebarLayout(closeSlot(state.sidebarLayout, "discussion"))
          : this.openSessionDiscussionSlot(),
    };
  }

  protected renderSessionDiscussionAction(action = this.resolveSessionDiscussionAction()) {
    if (!action) {
      return nothing;
    }
    return html`
      <openclaw-tooltip .content=${action.label}>
        <button
          class="btn btn--ghost btn--icon chat-icon-btn chat-session-discussion-toggle"
          type="button"
          aria-label=${action.label}
          aria-pressed=${String(action.active)}
          @click=${action.onToggle}
        >
          ${icons.messageSquare}
        </button>
      </openclaw-tooltip>
    `;
  }
}
