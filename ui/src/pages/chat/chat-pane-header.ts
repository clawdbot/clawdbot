import { ChatPaneContext } from "./chat-pane-context.ts";
import {
  copyToClipboard,
  hasOperatorWriteAccess,
  html,
  icons,
  isCloudWorkerPlacementState,
  isGatewayMethodAdvertised,
  parseAgentSessionKey,
  nothing,
  t,
  type ChatPaneHeaderAction,
  type GatewayBrowserClient,
  type GatewaySessionRow,
  type SessionDiscussionInfo,
  type SessionDiscussionState,
  type SessionsFilesRevealResult,
  type SidebarContent,
  type SystemInfoResult,
  type WorktreesBranchesResult,
  type WorktreesListResult,
} from "./chat-pane-deps.ts";
import { headerPlatformByClient } from "./chat-pane-shared.ts";

export abstract class ChatPaneHeader extends ChatPaneContext {
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
  // already-open sidebar is never stolen.
  protected maybeAutoShowSessionDiscussion(
    sessionKey: string,
    discussionState: SessionDiscussionState,
  ) {
    const state = this.state;
    if (
      discussionState !== "open" ||
      !state ||
      state.sessionKey.trim() !== sessionKey ||
      state.sidebarOpen
    ) {
      return;
    }
    const content = this.buildSessionDiscussionContent(state, sessionKey);
    if (content) {
      state.handleOpenSidebar(content);
    }
  }

  protected buildSessionDiscussionContent(
    state: NonNullable<typeof this.state>,
    sessionKey: string,
  ): SidebarContent | null {
    if (!state.connected || !state.client) {
      return null;
    }
    const canOpen =
      hasOperatorWriteAccess(this.context.gateway.snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "session.discussion.open") === true;
    const contentGeneration = this.connectionGeneration;
    const content: SidebarContent = {
      kind: "session-discussion",
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
        const current = state.sidebarContent;
        if (
          discussionState === "none" &&
          current?.kind === "session-discussion" &&
          current.sessionKey === key
        ) {
          state.handleCloseSidebar();
          return;
        }
        if (
          isCurrentSession &&
          current?.kind === "session-discussion" &&
          current.sessionKey === key
        ) {
          state.sidebarContent = { ...current, openUrl };
        }
        state.requestUpdate();
      },
    };
    return content;
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
    const content = this.buildSessionDiscussionContent(state, sessionKey);
    if (!content) {
      return nothing;
    }
    const active =
      state.sidebarOpen &&
      state.sidebarContent?.kind === "session-discussion" &&
      state.sidebarContent.sessionKey === sessionKey;
    const label = t(active ? "chat.sessionDiscussion.hide" : "chat.sessionDiscussion.show");
    return html`
      <openclaw-tooltip .content=${label}>
        <button
          class="btn btn--ghost btn--icon chat-icon-btn chat-session-discussion-toggle"
          type="button"
          aria-label=${label}
          aria-pressed=${String(active)}
          @click=${() => (active ? state.handleCloseSidebar() : state.handleOpenSidebar(content))}
        >
          ${icons.messageSquare}
        </button>
      </openclaw-tooltip>
    `;
  }
}
