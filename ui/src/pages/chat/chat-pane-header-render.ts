import {
  hasAbortableSessionRun,
  canRevealSessionWorkspace,
  hasOperatorAdminAccess,
  hasOperatorWriteAccess,
  hasSessionPresenceViewers,
  html,
  isChatRunWorking,
  isCloudWorkerPlacementState,
  isGatewayMethodAdvertised,
  listSessionCreators,
  nothing,
  renderBackgroundTasksToggle,
  renderBoardDockMenu,
  renderBoardFaceToggle,
  renderCatalogTerminalButton,
  renderChatPaneHeader,
  renderChatSessionSharing,
  renderSessionDiffToggle,
  renderSessionWorkspaceToggle,
  resolveChatPaneWorkspace,
  t,
  type BackgroundTasksProps,
  type GatewaySessionRow,
  type SessionWorkspaceProps,
} from "./chat-pane-deps.ts";
import { ChatPaneHeader } from "./chat-pane-header.ts";

export abstract class ChatPaneHeaderRender extends ChatPaneHeader {
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
    return renderChatPaneHeader({
      paneId: this.paneId,
      narrow: this.narrow,
      mergedChrome: this.mergedChrome,
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
}
