// Full-page new-session draft: pick agent, exec host, folder, and branch/worktree,
// then the first message creates the session in one sessions.create call.
import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { beginNativeWindowDragFromTopInset } from "../../app/native-window-drag.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { loadSettings } from "../../app/settings.ts";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import { buildAgentMainSessionKey, normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderWelcomeState } from "../chat/components/chat-welcome.ts";
import { admitStoredChatComposerQueueItem } from "../chat/composer-persistence.ts";
import { buildDraftSessionCreateParams } from "./create-params.ts";

type NewSessionRouteData = { agentId?: string };

type DraftBranches = {
  repoRoot: string;
  branches: Array<{ name: string; kind: "local" | "remote" }>;
  defaultBranch?: string;
  headBranch?: string;
};

type DraftNode = {
  nodeId: string;
  displayName: string;
  canExec: boolean;
  canBrowse: boolean;
};

type BrowserTarget = { nodeId: string; label: string };

const WORKTREE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

class NewSessionPage extends OpenClawLightDomElement {
  @property({ attribute: false }) data: NewSessionRouteData | undefined;

  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @state() private agentId = "";
  @state() private folder = "";
  @state() private worktree = false;
  @state() private worktreeName = "";
  @state() private baseRef = "";
  @state() private branches: DraftBranches | null = null;
  @state() private branchesLoading = false;
  @state() private nodes: DraftNode[] = [];
  @state() private execNode = "";
  @state() private message = "";
  @state() private submitting = false;
  @state() private error: string | null = null;
  @state() private browserOpen = false;
  @state() private browserLoading = false;
  @state() private browserError: string | null = null;
  @state() private browserListing: FsListDirResult | null = null;
  @state() private browserTarget: BrowserTarget | null = null;

  private openedFor: string | null = null;
  private agentsHydrated = false;
  private branchesRequestToken = 0;
  private browserRequestToken = 0;

  // Re-render when agents/sessions hydrate so the hero identity and the
  // recent-chats list appear without a route change.
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
    )
    .watch(
      () => this.context?.sessions,
      (sessions, notify) => sessions.subscribe(notify),
    );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override updated() {
    const agentsReady = this.agents().length > 0;
    const openKey = this.data?.agentId ?? "";
    if (this.openedFor !== openKey) {
      this.openedFor = openKey;
      this.agentsHydrated = agentsReady;
      this.resetDraft();
      return;
    }
    // A hard reload can land here before agents.list resolves. Once the list
    // arrives, adopt only agent-derived defaults; a full reset would discard
    // anything the user already typed while the list was loading.
    if (!this.agentsHydrated && agentsReady) {
      this.agentsHydrated = true;
      this.adoptAgentDefaults();
    }
  }

  private agents() {
    return this.context?.agents.state.agentsList?.agents ?? [];
  }

  private selectedAgent() {
    const agentId = normalizeAgentId(this.agentId);
    return this.agents().find((agent) => normalizeAgentId(agent.id) === agentId);
  }

  private execNodes(): DraftNode[] {
    return this.nodes.filter((node) => node.canExec);
  }

  private isAdmin(): boolean {
    return hasOperatorAdminAccess(this.context?.gateway.snapshot.hello?.auth ?? null);
  }

  private workspacePath(): string {
    return normalizeOptionalString(this.selectedAgent()?.workspace) ?? "";
  }

  private usesCustomFolder(): boolean {
    const folder = this.folder.trim();
    return Boolean(folder) && folder !== this.workspacePath();
  }

  /** Resolves the agent selection and workspace-derived fields; keeps user input. */
  private adoptAgentDefaults() {
    const agents = this.agents();
    const requested = normalizeAgentId(this.data?.agentId || "");
    const fallback = this.context?.agents.state.agentsList?.defaultId ?? agents[0]?.id ?? "main";
    this.agentId = agents.some((agent) => normalizeAgentId(agent.id) === requested)
      ? requested
      : normalizeAgentId(fallback);
    if (!this.folder.trim()) {
      this.folder = this.workspacePath();
    }
    void this.loadNodes();
    this.maybeLoadBranches();
  }

  private resetDraft() {
    this.folder = "";
    this.worktree = false;
    this.worktreeName = "";
    this.baseRef = "";
    this.branches = null;
    this.branchesLoading = false;
    this.execNode = "";
    this.message = "";
    this.submitting = false;
    this.error = null;
    this.closeBrowser();
    this.adoptAgentDefaults();
    void this.updateComplete.then(() => {
      this.querySelector<HTMLTextAreaElement>(".new-session-page__message")?.focus();
    });
  }

  private async loadNodes() {
    const client = this.context?.gateway.snapshot.client;
    if (!client || !this.isAdmin()) {
      this.nodes = [];
      return;
    }
    try {
      const result = await client.request<{ nodes?: unknown }>("node.list", {});
      const rawNodes = Array.isArray(result?.nodes) ? (result.nodes as Array<unknown>) : [];
      this.nodes = rawNodes
        .flatMap((raw) => {
          const node = raw as {
            nodeId?: unknown;
            displayName?: unknown;
            connected?: unknown;
            commands?: unknown;
          };
          const nodeId = normalizeOptionalString(node.nodeId);
          const commands = Array.isArray(node.commands)
            ? node.commands.filter((command): command is string => typeof command === "string")
            : [];
          if (!nodeId) {
            return [];
          }
          const connected = node.connected === true;
          const canExec = connected && commands.includes("system.run");
          return [
            {
              nodeId,
              displayName: normalizeOptionalString(node.displayName) ?? nodeId,
              canExec,
              canBrowse: canExec && commands.includes("fs.listDir"),
            },
          ];
        })
        .toSorted(
          (left, right) =>
            left.displayName.localeCompare(right.displayName) ||
            left.nodeId.localeCompare(right.nodeId),
        );
    } catch {
      this.nodes = [];
    }
  }

  private maybeLoadBranches() {
    if (this.execNode) {
      this.branchesRequestToken += 1;
      this.branches = null;
      this.branchesLoading = false;
      this.baseRef = "";
      return;
    }
    const repoRoot = this.folder.trim() || this.workspacePath();
    const agent = this.selectedAgent();
    const usesWorkspace = repoRoot === this.workspacePath();
    if (!repoRoot || (usesWorkspace && agent?.workspaceGit !== true)) {
      this.branches = null;
      return;
    }
    const client = this.context?.gateway.snapshot.client;
    if (!client) {
      return;
    }
    const requestId = ++this.branchesRequestToken;
    this.branchesLoading = true;
    void client
      .request<DraftBranches>("worktrees.branches", { repoRoot })
      .then((result) => {
        if (requestId !== this.branchesRequestToken) {
          return;
        }
        this.branches = result ? { ...result, repoRoot } : null;
        this.baseRef = result?.defaultBranch ?? result?.headBranch ?? "";
      })
      .catch(() => {
        if (requestId === this.branchesRequestToken) {
          this.branches = null;
        }
      })
      .finally(() => {
        if (requestId === this.branchesRequestToken) {
          this.branchesLoading = false;
        }
      });
  }

  private worktreeAvailable(): boolean {
    if (this.execNode) {
      return false;
    }
    if (this.usesCustomFolder()) {
      return this.isAdmin();
    }
    return this.selectedAgent()?.workspaceGit === true;
  }

  private canSubmit(): boolean {
    if (this.submitting || !this.message.trim() || !this.context?.gateway.snapshot.connected) {
      return false;
    }
    // Pre-hydration the selection is a provisional fallback; submitting then
    // would create the session under the wrong agent.
    if (this.agents().length === 0) {
      return false;
    }
    if (this.usesCustomFolder() && (!this.isAdmin() || (!this.execNode && !this.worktree))) {
      return false;
    }
    if (this.execNode && this.worktree) {
      return false;
    }
    if (this.worktree && !this.worktreeAvailable()) {
      return false;
    }
    const name = this.worktreeName.trim();
    if (this.worktree && name && !WORKTREE_NAME_PATTERN.test(name)) {
      return false;
    }
    return true;
  }

  private async submit() {
    const context = this.context;
    if (!context || !this.canSubmit()) {
      return;
    }
    const message = this.message.trim();
    this.submitting = true;
    this.error = null;
    try {
      const result = await context.sessions.createResult(
        buildDraftSessionCreateParams({
          agentId: this.agentId,
          message,
          worktree: this.worktree,
          baseRef: this.baseRef,
          worktreeName: this.worktreeName,
          cwd: this.folder,
          workspace: this.workspacePath(),
          execNode: this.execNode,
        }),
      );
      if (!result) {
        this.error = context.sessions.state.error ?? t("newSession.createFailed");
        return;
      }
      if (result.initialRun.status === "rejected") {
        const gateway = context.gateway.snapshot;
        const persisted = admitStoredChatComposerQueueItem(
          {
            settings: loadSettings(),
            assistantAgentId: gateway.assistantAgentId,
            agentsList: context.agents.state.agentsList,
            hello: gateway.hello,
          },
          result.key,
          {
            id: generateUUID(),
            text: message,
            createdAt: Date.now(),
            kind: "queued",
            refreshSessions: true,
            sendAttempts: 1,
            sendError: result.initialRun.error,
            sendState: "failed",
            sessionKey: result.key,
            agentId: normalizeAgentId(this.agentId),
          },
        );
        if (!persisted) {
          // Stay on the draft when browser storage is unavailable: preserving
          // the typed task takes priority over navigating to the partial session.
          this.error = result.initialRun.error;
          return;
        }
      }
      context.gateway.setSessionKey(result.key);
      context.navigate("chat", { search: searchForSession(result.key) });
    } finally {
      this.submitting = false;
    }
  }

  private selectAgentId(agentId: string) {
    this.agentId = normalizeAgentId(agentId);
    this.folder = this.execNode ? "" : this.workspacePath();
    this.worktree = false;
    this.worktreeName = "";
    this.closeBrowser();
    this.maybeLoadBranches();
  }

  private applyFolder(folder: string, execNode = this.execNode) {
    this.execNode = execNode;
    this.folder = folder.trim();
    if (this.execNode) {
      this.worktree = false;
    } else if (this.usesCustomFolder()) {
      // Explicit host paths only materialize through a managed worktree.
      this.worktree = true;
    }
    this.maybeLoadBranches();
  }

  private selectExecNode(execNode: string) {
    if (execNode === this.execNode) {
      return;
    }
    this.execNode = execNode;
    // Folder paths belong to one host; never carry a Gateway or node path to another host.
    this.folder = execNode ? "" : this.workspacePath();
    this.worktree = false;
    this.closeBrowser();
    this.maybeLoadBranches();
  }

  private browseAvailable(): boolean {
    return this.isAdmin();
  }

  private closeBrowser() {
    this.browserRequestToken += 1;
    this.browserOpen = false;
    this.browserLoading = false;
    this.browserError = null;
    this.browserListing = null;
    this.browserTarget = null;
  }

  private toggleBrowser() {
    if (this.browserOpen) {
      this.closeBrowser();
      return;
    }
    this.browserOpen = true;
    this.showBrowserRoot();
  }

  private showBrowserRoot() {
    this.browserRequestToken += 1;
    this.browserLoading = false;
    this.browserError = null;
    this.browserListing = null;
    this.browserTarget = null;
  }

  private selectBrowserTarget(target: BrowserTarget) {
    const folder = this.folder.trim();
    const matchesCurrentTarget = target.nodeId === this.execNode;
    const path =
      matchesCurrentTarget &&
      (folder.startsWith("/") || folder.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(folder))
        ? folder
        : undefined;
    this.browserTarget = target;
    this.loadBrowser(path);
  }

  private loadBrowser(path: string | undefined) {
    const client = this.context?.gateway.snapshot.client;
    const target = this.browserTarget;
    if (!client || !target) {
      return;
    }
    const requestId = ++this.browserRequestToken;
    this.browserLoading = true;
    this.browserError = null;
    // Clear the previous directory immediately: keeping it clickable while the
    // request is in flight would let "Use this folder" apply the stale path.
    this.browserListing = null;
    void client
      .request<FsListDirResult>("fs.listDir", {
        ...(path ? { path } : {}),
        ...(target.nodeId ? { nodeId: target.nodeId } : {}),
      })
      .then((result) => {
        if (requestId !== this.browserRequestToken) {
          return;
        }
        this.browserListing = result ?? null;
      })
      .catch(() => {
        if (requestId !== this.browserRequestToken) {
          return;
        }
        // A stale or mistyped folder should not strand the picker: fall back home.
        if (path) {
          this.loadBrowser(undefined);
          return;
        }
        this.browserError = t("newSession.browserLoadFailed");
      })
      .finally(() => {
        if (requestId === this.browserRequestToken) {
          this.browserLoading = false;
        }
      });
  }

  private renderBrowser() {
    if (!this.browserOpen) {
      return nothing;
    }
    const listing = this.browserListing;
    const target = this.browserTarget;
    return html`
      <div class="new-session-page__browser">
        <div class="new-session-page__browser-head">
          <button
            type="button"
            class="new-session-page__browser-nav"
            title=${t("newSession.browserUp")}
            aria-label=${t("newSession.browserUp")}
            ?disabled=${!target || (!listing && this.browserLoading)}
            @click=${() => {
              if (listing?.parent) {
                this.loadBrowser(listing.parent);
              } else if (target) {
                this.showBrowserRoot();
              }
            }}
          >
            ${icons.arrowLeft}
          </button>
          <span class="new-session-page__browser-path"
            >${target
              ? `${target.label}${listing?.path ? ` · ${listing.path}` : ""}`
              : t("newSession.where")}${this.browserLoading
              ? ` · ${t("common.loading")}`
              : ""}</span
          >
          <button
            type="button"
            class="new-session-page__browser-nav"
            title=${t("common.close")}
            aria-label=${t("common.close")}
            @click=${() => this.closeBrowser()}
          >
            ${icons.x}
          </button>
        </div>
        ${this.browserError
          ? html`<div class="new-session-page__error">${this.browserError}</div>`
          : nothing}
        <div class="new-session-page__browser-list" role="listbox">
          ${!target
            ? html`
                <button
                  type="button"
                  class="new-session-page__browser-entry"
                  @click=${() =>
                    this.selectBrowserTarget({ nodeId: "", label: t("newSession.gateway") })}
                >
                  <span class="new-session-page__target-icon" aria-hidden="true"
                    >${icons.monitor}</span
                  >
                  <span>${t("newSession.gateway")}</span>
                </button>
                ${this.nodes.map(
                  (node) => html`
                    <button
                      type="button"
                      class="new-session-page__browser-entry"
                      ?disabled=${!node.canBrowse}
                      @click=${() =>
                        this.selectBrowserTarget({
                          nodeId: node.nodeId,
                          label: node.displayName,
                        })}
                    >
                      <span class="new-session-page__target-icon" aria-hidden="true"
                        >${icons.monitor}</span
                      >
                      <span>${node.displayName}</span>
                    </button>
                  `,
                )}
              `
            : nothing}
          ${listing && listing.entries.length === 0 && !this.browserLoading
            ? html`<div class="new-session-page__browser-empty">
                ${t("newSession.browserEmpty")}
              </div>`
            : nothing}
          ${target
            ? (listing?.entries ?? []).map(
                (entry) => html`
                  <button
                    type="button"
                    class="new-session-page__browser-entry ${entry.hidden
                      ? "new-session-page__browser-entry--hidden"
                      : ""}"
                    @click=${() => this.loadBrowser(entry.path)}
                  >
                    <span class="new-session-page__target-icon" aria-hidden="true"
                      >${icons.folder}</span
                    >
                    <span>${entry.name}</span>
                  </button>
                `,
              )
            : nothing}
        </div>
        <div class="new-session-page__browser-actions">
          <button
            type="button"
            class="new-session-page__browser-use"
            ?disabled=${!listing || !target}
            @click=${() => {
              if (listing && target) {
                this.applyFolder(listing.path, target.nodeId);
                this.closeBrowser();
              }
            }}
          >
            ${t("newSession.browserUse")}
          </button>
        </div>
      </div>
    `;
  }

  private renderTargetBar() {
    const agents = this.agents();
    const execNodes = this.execNodes();
    const isAdmin = this.isAdmin();
    const customFolder = this.usesCustomFolder();
    const worktreeAvailable = this.worktreeAvailable();
    const branches = this.branches;
    return html`
      <div class="new-session-page__targets">
        ${agents.length > 1
          ? html`
              <label class="new-session-page__target" title=${t("newSession.agent")}>
                <span class="new-session-page__target-icon" aria-hidden="true">${icons.bot}</span>
                <select
                  aria-label=${t("newSession.agent")}
                  .value=${this.agentId}
                  @change=${(event: Event) =>
                    this.selectAgentId((event.target as HTMLSelectElement).value)}
                >
                  ${agents.map(
                    (option) => html`
                      <option
                        value=${option.id}
                        ?selected=${normalizeAgentId(option.id) === this.agentId}
                      >
                        ${option.identity?.name ?? option.name ?? option.id}
                      </option>
                    `,
                  )}
                </select>
              </label>
            `
          : nothing}
        ${isAdmin && execNodes.length > 0
          ? html`
              <label class="new-session-page__target" title=${t("newSession.where")}>
                <span class="new-session-page__target-icon" aria-hidden="true"
                  >${icons.monitor}</span
                >
                <select
                  aria-label=${t("newSession.where")}
                  .value=${this.execNode}
                  @change=${(event: Event) => {
                    this.selectExecNode((event.target as HTMLSelectElement).value);
                  }}
                >
                  <option value="" ?selected=${!this.execNode}>${t("newSession.gateway")}</option>
                  ${execNodes.map(
                    (node) => html`
                      <option value=${node.nodeId} ?selected=${this.execNode === node.nodeId}>
                        ${node.displayName}
                      </option>
                    `,
                  )}
                </select>
              </label>
            `
          : nothing}
        <label
          class="new-session-page__target new-session-page__target--folder"
          title=${t("newSession.folder")}
        >
          <span class="new-session-page__target-icon" aria-hidden="true">${icons.folder}</span>
          <input
            type="text"
            aria-label=${t("newSession.folder")}
            placeholder=${this.execNode
              ? t("newSession.folderPlaceholder")
              : this.workspacePath() || t("newSession.folderPlaceholder")}
            .value=${this.folder}
            ?disabled=${!isAdmin}
            @input=${(event: Event) => {
              // Track keystrokes so a re-render (e.g. agent hydration) cannot
              // overwrite an in-progress edit; side effects wait for change.
              this.folder = (event.target as HTMLInputElement).value;
            }}
            @change=${(event: Event) => this.applyFolder((event.target as HTMLInputElement).value)}
          />
          ${this.browseAvailable()
            ? html`
                <button
                  type="button"
                  class="new-session-page__browse"
                  title=${t("newSession.browse")}
                  aria-label=${t("newSession.browse")}
                  aria-expanded=${String(this.browserOpen)}
                  @click=${() => this.toggleBrowser()}
                >
                  ${icons.folderOpen}
                </button>
              `
            : nothing}
        </label>
        <div class="new-session-page__target-group">
          <label
            class="new-session-page__target new-session-page__target--toggle"
            title=${worktreeAvailable
              ? t("chat.runControls.newSessionWorktree")
              : t("newSession.worktreeUnavailable")}
          >
            <input
              type="checkbox"
              .checked=${this.worktree}
              ?disabled=${!worktreeAvailable || customFolder}
              @change=${(event: Event) => {
                this.worktree = (event.target as HTMLInputElement).checked;
                if (this.worktree) {
                  this.maybeLoadBranches();
                }
              }}
            />
            <span class="new-session-page__target-icon" aria-hidden="true">${icons.gitBranch}</span>
            <span>${t("newSession.worktree")}</span>
          </label>
          ${this.worktree
            ? html`
                <label class="new-session-page__target" title=${t("newSession.baseBranch")}>
                  <input
                    type="text"
                    list="new-session-branches"
                    class="new-session-page__branch"
                    aria-label=${t("newSession.baseBranch")}
                    placeholder=${this.branchesLoading
                      ? t("common.loading")
                      : (branches?.defaultBranch ?? t("newSession.baseBranch"))}
                    .value=${this.baseRef}
                    @input=${(event: Event) => {
                      this.baseRef = (event.target as HTMLInputElement).value.trim();
                    }}
                  />
                  <datalist id="new-session-branches">
                    ${(branches?.branches ?? []).map(
                      (branch) => html`<option value=${branch.name}></option>`,
                    )}
                  </datalist>
                </label>
                <label class="new-session-page__target" title=${t("newSession.worktreeName")}>
                  <input
                    type="text"
                    class="new-session-page__branch"
                    aria-label=${t("newSession.worktreeName")}
                    placeholder=${t("newSession.worktreeNamePlaceholder")}
                    .value=${this.worktreeName}
                    @input=${(event: Event) => {
                      this.worktreeName = (event.target as HTMLInputElement).value.trim();
                    }}
                  />
                </label>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  /** Target row + composer, rendered mid-screen between the hero and recents. */
  private renderDraftBlock() {
    const worktreeNameInvalid =
      this.worktree &&
      this.worktreeName.trim() !== "" &&
      !WORKTREE_NAME_PATTERN.test(this.worktreeName.trim());
    return html`
      <div class="new-session-page__draft">
        ${this.renderTargetBar()} ${this.renderBrowser()}
        ${worktreeNameInvalid
          ? html`<div class="new-session-page__error">${t("newSession.worktreeNameInvalid")}</div>`
          : nothing}
        ${this.error ? html`<div class="new-session-page__error">${this.error}</div>` : nothing}
        ${this.renderComposer()}
      </div>
    `;
  }

  /** Same welcome block as the empty-chat start screen, keyed to the draft's agent. */
  private renderWelcome() {
    const agent = this.selectedAgent();
    const identity = agent?.identity;
    const gateway = this.context?.gateway.snapshot;
    return renderWelcomeState({
      assistantName: identity?.name ?? agent?.name ?? agent?.id ?? "",
      assistantAvatar: identity?.avatar ?? identity?.emoji ?? null,
      assistantAvatarUrl: identity?.avatarUrl ?? null,
      hint: t("newSession.hint"),
      composer: this.renderDraftBlock(),
      sessions: this.context?.sessions.state.result,
      sessionKey: buildAgentMainSessionKey({
        agentId: this.agentId || "main",
        mainKey: this.context?.agents.state.agentsList?.mainKey,
      }),
      sessionHost: {
        assistantAgentId: gateway?.assistantAgentId ?? null,
        agentsList: this.context?.agents.state.agentsList ?? null,
        hello: gateway?.hello ?? null,
      },
      onDraftChange: (next) => {
        this.message = next;
      },
      onSend: () => void this.submit(),
      onOpenSession: (sessionKey) => {
        this.context?.gateway.setSessionKey(sessionKey);
        this.context?.navigate("chat", { search: searchForSession(sessionKey) });
      },
    });
  }

  override render() {
    return html`
      <div class="new-session-page">
        <div class="new-session-page__scroll" @mousedown=${beginNativeWindowDragFromTopInset}>
          ${this.renderWelcome()}
        </div>
      </div>
    `;
  }

  private handleMessageKeydown(event: KeyboardEvent) {
    // keyCode 229 mirrors the chat composer's IME guard: some browsers emit
    // the candidate-confirm Enter with isComposing === false.
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) {
      return;
    }
    // Honor the chat composer's send-shortcut setting so the draft picker
    // sends exactly like an existing session's composer.
    const requiresModifier = loadSettings().chatSendShortcut === "modifier-enter";
    if (!requiresModifier || event.metaKey || event.ctrlKey) {
      event.preventDefault();
      void this.submit();
    }
  }

  /** Draft message box styled as the chat composer shell so both pickers match. */
  private renderComposer() {
    const startLabel = this.submitting ? t("newSession.starting") : t("newSession.start");
    return html`
      <div class="agent-chat__input new-session-page__composer">
        <div class="agent-chat__composer-input-row">
          <div class="agent-chat__composer-combobox">
            <textarea
              class="new-session-page__message"
              rows="3"
              placeholder=${t("newSession.messagePlaceholder")}
              .value=${this.message}
              @input=${(event: Event) => {
                this.message = (event.target as HTMLTextAreaElement).value;
              }}
              @keydown=${(event: KeyboardEvent) => this.handleMessageKeydown(event)}
            ></textarea>
          </div>
          <div class="agent-chat__composer-actions">
            <openclaw-tooltip content=${t("newSession.start")}>
              <button
                type="button"
                class="chat-send-btn"
                ?disabled=${!this.canSubmit()}
                aria-label=${startLabel}
                @click=${() => void this.submit()}
              >
                ${this.submitting ? icons.loader : icons.send}
              </button>
            </openclaw-tooltip>
          </div>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-new-session-page")) {
  customElements.define("openclaw-new-session-page", NewSessionPage);
}

export type { NewSessionPage };
