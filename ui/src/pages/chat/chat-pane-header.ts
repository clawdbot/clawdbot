import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing } from "lit";
import { buildControlUiResourcePath } from "../../../../src/gateway/control-ui-resource-routes.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { isDesktopPanelAvailable } from "../../app/app-shell-chrome.ts";
import { resolveControlUiAuthCandidates } from "../../app/control-ui-auth.ts";
import { isNativeLocalGateway } from "../../app/native-editor-locality.runtime.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { COMMAND_PALETTE_OPEN_EVENT } from "../../components/command-palette-contract.ts";
import { icons } from "../../components/icons.ts";
import {
  personActivityRouting,
  type PersonActivityRouting,
} from "../../components/person-activity-link.ts";
import { sessionMenuReasons } from "../../components/session-menu-access.ts";
import { listAssignableSessionOwners } from "../../components/session-owner-chip.ts";
import { isCloudWorkerPlacementState } from "../../components/session-row-badges.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { hasSessionPresenceViewers, projectPresencePayload } from "../../lib/presence-users.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { collectKnownSessionGroups } from "../../lib/sessions/grouping.ts";
import {
  canArchiveSessionRow,
  canDeleteSessionRows,
  resolveUiConfiguredMainKey,
  resolveUiSessionNavigationParentKey,
} from "../../lib/sessions/session-key.ts";
import { renderBoardViewSwitch } from "./board-session-surface.ts";
import { displayedChatSessionBranches } from "./chat-history.ts";
import { ChatPaneDiscussion } from "./chat-pane-discussion.ts";
import { resolveChatPaneDesktopTarget, resolveChatPanePlacement } from "./chat-pane-placement.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import { renderBackgroundTasksToggle } from "./components/chat-background-tasks-render.ts";
import type { BackgroundTasksProps } from "./components/chat-background-tasks.types.ts";
import { isChatRunWorking } from "./components/chat-composer.ts";
import "./components/chat-header-session-menu.ts";
import type {
  HeaderMenuAction,
  HeaderMenuActionKind,
  HeaderMenuQuickAction,
  HeaderMenuStatusAction,
} from "./components/chat-header-session-menu.ts";
import {
  canRevealSessionWorkspace,
  renderChatPaneHeader,
  resolveChatPaneParentSession,
  resolveChatPaneWorkspace,
} from "./components/chat-pane-header.ts";
import { renderChatSessionSharing } from "./components/chat-session-sharing.ts";
import type { SessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import { renderContinueInTerminalDialog } from "./components/continue-in-terminal-dialog.ts";
import { hasAbortableSessionRun } from "./run-lifecycle.ts";
import type { SidebarLayout } from "./sidebar-layout.ts";

export abstract class ChatPaneHeader extends ChatPaneDiscussion {
  /** Gateway-served project icon for a session workspace, on the same credentials as agent avatars. */
  private personActivityRouting(): PersonActivityRouting {
    return personActivityRouting(this.context);
  }

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
      routeUrl: buildControlUiResourcePath(
        "workspaceIcon",
        this.context.resourceBasePath,
        sessionKey,
      ),
      authTokens,
      authReady: Boolean(gateway.snapshot.hello || authTokens.length),
    };
  }

  private compactHeaderStatusActions(): HeaderMenuStatusAction[] {
    if (!this.narrow || !this.context.overlays.snapshot.controlUiRefreshRequired) {
      return [];
    }
    return [
      {
        id: "refresh",
        label: `${t("chat.sidebar.serverUpdatedTitle")} · ${t(
          "chat.sidebar.serverUpdatedRefresh",
        )}`,
        icon: icons.refresh,
        tone: "info",
        onActivate: () => globalThis.location.reload(),
      },
    ];
  }

  protected renderPaneHeader(
    sessionWorkspace: SessionWorkspaceProps,
    backgroundTasks: BackgroundTasksProps,
    row: GatewaySessionRow | undefined,
    catalog: boolean,
    agentWorkspace: string | undefined,
    workspaceGit: boolean,
    sidebarLayout?: SidebarLayout,
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
    const branchSwitchDisabledReason =
      this.state && this.isCurrentSessionArchived(this.state)
        ? t("chat.archivedSessionDisabled")
        : !branchSwitchAccess.allowed
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
      method: "session.members.listEvidence",
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
    const assignmentAccess = row
      ? readSessionMethodAccess(this.context.gateway.snapshot, {
          method: "sessions.assignOwner",
          params: {
            key: row.key,
            owner: { type: "human", id: sharingSnapshot.selfUser?.id ?? "profile" },
          },
          requiredScope: "operator.write",
        })
      : null;
    const continueInTerminalDisabledReason = row
      ? this.continueInTerminalDisabledReason(row)
      : undefined;
    const actionDisabledReasons: Partial<Record<HeaderMenuActionKind, string>> = {
      ...sessionActionDisabledReasons,
      ...(assignmentAccess && !assignmentAccess.allowed
        ? { "assign-owner": assignmentAccess.reason }
        : {}),
      ...(continueInTerminalDisabledReason
        ? { "continue-in-terminal": continueInTerminalDisabledReason }
        : {}),
    };
    const desktopEnvironmentId = resolveChatPaneDesktopTarget(row);
    const desktopPanelAvailable =
      desktopEnvironmentId !== null && isDesktopPanelAvailable(this.context.gateway.snapshot);
    const openDesktopPanel = sessionWorkspace.onToggleDesktop ?? (() => undefined);
    const discussion = this.resolveSessionDiscussionAction();
    const sidePanelOpen = (sidebarLayout ?? this.state?.sidebarLayout)?.open === true;
    const toggleSidePanel = () => this.setChatSidePanelOpen(!sidePanelOpen, sidebarLayout);
    const sidePanelAction = html`<openclaw-tooltip
      .content=${t(sidePanelOpen ? "chat.sidePanel.minimize" : "chat.sidePanel.label")}
    >
      <button
        class="btn btn--ghost btn--icon chat-icon-btn chat-side-panel-toggle"
        type="button"
        aria-label=${t(sidePanelOpen ? "chat.sidePanel.minimize" : "chat.sidePanel.label")}
        aria-expanded=${String(sidePanelOpen)}
        @click=${toggleSidePanel}
      >
        ${sidePanelOpen ? icons.panelRightClose : icons.panelRightOpen}
      </button>
    </openclaw-tooltip>`;
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
    const backgroundTasksAction = catalog ? nothing : renderBackgroundTasksToggle(backgroundTasks);
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
    if (desktopPanelAvailable && sessionWorkspace.onToggleDesktop) {
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
        badge: backgroundTasks.activeCount,
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
      movingKey: this.headerPlacementMovingKey,
      reclaimingKey: this.headerPlacementReclaimingKey,
      row,
    });
    const key = this.state?.sessionKey ?? "";
    const selfId = sharingSnapshot.selfUser?.id;
    const instanceId = sharingSnapshot.client?.instanceId;
    const result = this.state?.sessionsResult;
    const knownGroups = collectKnownSessionGroups(
      this.context.sessions?.state?.groups ?? [],
      this.context.sessions?.state?.result?.sessions ?? [],
    );
    const showOwnerChip = (result?.owners?.length ?? 0) >= 2 || (row?.participantCount ?? 0) > 0;
    const personActivity = this.personActivityRouting();
    const renderedOwnerId = showOwnerChip ? row?.owner?.actor.id : undefined;
    const presence = projectPresencePayload(this.presencePayload, selfId, instanceId);
    const ownerViewing = presence.users.some(
      (user) => user.id === renderedOwnerId && user.watchedSessions.includes(key),
    );
    const ownerOptions = listAssignableSessionOwners({
      facet: result?.owners,
      agents: this.context.agents.state.agentsList?.agents,
      self: sharingSnapshot.selfUser ?? null,
    });
    const selfOwner = sharingSnapshot.selfUser
      ? (ownerOptions.find(
          (owner) => owner.type === "human" && owner.id === sharingSnapshot.selfUser?.id,
        ) ?? null)
      : null;
    const header = renderChatPaneHeader({
      paneId: this.paneId,
      narrow: this.narrow,
      mergedChrome: this.mergedChrome,
      navDrawerOpen: this.navDrawerOpen,
      title: this.paneTitle,
      session: row,
      showOwnerChip,
      ownerViewing,
      personActivity,
      catalog,
      editing: this.headerEditing && this.headerRenameSessionKey === row?.key,
      renameValue: this.headerRenameValue,
      workspaceRoot: workspace.root,
      workspaceLabel: workspace.label,
      workspaceIcon: this.resolveWorkspaceIcon(workspace.root ? row?.key : undefined),
      parentSession: resolveChatPaneParentSession(row, this.state?.sessionsResult?.sessions ?? []),
      branch,
      branches: this.state ? displayedChatSessionBranches(this.state) : [],
      branchSwitchDisabledReason,
      platform: this.headerPlatform,
      canReveal,
      copiedAction: this.headerCopiedAction,
      renameDisabledReason,
      panelActions: html`${browserPanelAction}${backgroundTasksAction}${sidePanelAction}`,
      discussionAction: nothing,
      diffAction: nothing,
      backgroundTasksAction: nothing,
      sessionRailAction: nothing,
      workspaceAction: nothing,
      presence:
        !catalog &&
        hasSessionPresenceViewers(this.presencePayload, selfId, instanceId, key, renderedOwnerId)
          ? html`<openclaw-viewer-facepile
              class="chat-pane__presence"
              .presencePayload=${this.presencePayload}
              .selfUserId=${selfId}
              .selfInstanceId=${instanceId}
              .sessionKey=${key}
              .excludeUserId=${renderedOwnerId}
              .maxVisible=${4}
              .personActivity=${personActivity}
              variant="session"
            ></openclaw-viewer-facepile>`
          : nothing,
      faceControl: renderBoardViewSwitch({
        hasBoard: board.hasBoard,
        face: board.face,
        dock: board.dock,
        canChangeDock: canChangeBoardDock,
        fullscreenControl: board.hasBoard ? this.boardFullscreen.renderButton() : undefined,
        onSelectMode: (mode) => {
          if (mode === "chat") {
            void this.boardFullscreen.exit();
          }
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
              .session=${{
                label:
                  normalizeOptionalString(row.label) ??
                  normalizeOptionalString(this.paneTitle) ??
                  row.key,
                sessionId: row.sessionId ?? null,
                isChild: Boolean(resolveUiSessionNavigationParentKey(row)),
                pinned: row.pinned === true,
                unread: row.unread === true,
                archived: row.archived === true,
                category: normalizeOptionalString(row.category) ?? null,
                icon: normalizeOptionalString(row.icon) ?? null,
                categoryClearReturnsToGroups: false,
              }}
              .worktreePath=${row.execNode || !isNativeLocalGateway() ? null : workspace.root}
              .onboarding=${this.onboarding}
              .preferencesBrowserOnly=${this.context.runtimeConfig?.state.connected &&
              this.context.runtimeConfig.canPatch === false}
              .compact=${this.narrow}
              .settings=${this.state.settings}
              .panelActions=${panelMenuActions}
              .layoutActions=${layoutMenuActions}
              .statusActions=${this.compactHeaderStatusActions()}
              .groups=${knownGroups}
              .ownerOptions=${ownerOptions}
              .selfOwner=${selfOwner}
              .currentOwnerId=${row.owner?.actor.id ?? null}
              .actionDisabledReasons=${actionDisabledReasons}
              .forkDisabled=${this.state.sessionsLoading || row.modelSelectionLocked === true}
              .forkFromLastCompleted=${row.hasActiveRun === true}
              .archiveAllowed=${archiveAllowed}
              .deleteAllowed=${deleteAllowed}
              .onOpen=${() => {
                void this.loadHeaderMenuData(row, agentWorkspace, workspaceGit);
              }}
              .onOpenCommandPalette=${() =>
                window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT))}
              .onSettingsChange=${this.state.applySettings}
              .onAction=${(action: HeaderMenuAction) => this.handleHeaderSessionAction(action, row)}
            ></openclaw-chat-header-session-menu>`
          : nothing,
      placementMoving: placement.moving,
      placementMoveDisabledReason: placement.moveDisabledReason,
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
      onPlacementMove: () => row && void this.moveHeaderPlacement(row),
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
}
