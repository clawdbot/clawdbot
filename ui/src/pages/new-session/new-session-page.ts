// Full-page new-session draft: pick agent, exec host, folder, and branch/worktree,
// then the first message creates the session in one sessions.create call.
import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
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
};

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

  private openedFor: string | null = null;
  private agentsHydrated = false;
  private branchesRequestToken = 0;
  private browserRequestToken = 0;

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
      this.nodes = rawNodes.flatMap((raw) => {
        const node = raw as {
          nodeId?: unknown;
          displayName?: unknown;
          connected?: unknown;
          commands?: unknown;
        };
        const nodeId = normalizeOptionalString(node.nodeId);
        const commands = Array.isArray(node.commands) ? (node.commands as string[]) : [];
        if (!nodeId || node.connected !== true || !commands.includes("system.run")) {
          return [];
        }
        return [{ nodeId, displayName: normalizeOptionalString(node.displayName) ?? nodeId }];
      });
    } catch {
      this.nodes = [];
    }
  }

  private maybeLoadBranches() {
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
    if (this.usesCustomFolder() && (!this.worktree || !this.isAdmin())) {
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
    this.submitting = true;
    this.error = null;
    try {
      const key = await context.sessions.create(
        buildDraftSessionCreateParams({
          agentId: this.agentId,
          message: this.message.trim(),
          worktree: this.worktree,
          baseRef: this.baseRef,
          worktreeName: this.worktreeName,
          cwd: this.folder,
          workspace: this.workspacePath(),
          execNode: this.execNode,
        }),
      );
      if (!key) {
        this.error = context.sessions.state.error ?? t("newSession.createFailed");
        return;
      }
      context.gateway.setSessionKey(key);
      context.navigate("chat", { search: searchForSession(key) });
    } finally {
      this.submitting = false;
    }
  }

  private selectAgentId(agentId: string) {
    this.agentId = normalizeAgentId(agentId);
    this.folder = this.workspacePath();
    this.worktree = false;
    this.worktreeName = "";
    this.closeBrowser();
    this.maybeLoadBranches();
  }

  private applyFolder(folder: string) {
    this.folder = folder.trim();
    if (this.usesCustomFolder()) {
      // Explicit host paths only materialize through a managed worktree.
      this.worktree = true;
    }
    this.maybeLoadBranches();
  }

  private browseAvailable(): boolean {
    // fs.listDir walks the gateway host; node-bound sessions need a typed path.
    return this.isAdmin() && !this.execNode;
  }

  private closeBrowser() {
    this.browserRequestToken += 1;
    this.browserOpen = false;
    this.browserLoading = false;
    this.browserError = null;
    this.browserListing = null;
  }

  private toggleBrowser() {
    if (this.browserOpen) {
      this.closeBrowser();
      return;
    }
    this.browserOpen = true;
    const folder = this.folder.trim();
    this.loadBrowser(folder.startsWith("/") || /^[A-Za-z]:[\\/]/.test(folder) ? folder : undefined);
  }

  private loadBrowser(path: string | undefined) {
    const client = this.context?.gateway.snapshot.client;
    if (!client) {
      return;
    }
    const requestId = ++this.browserRequestToken;
    this.browserLoading = true;
    this.browserError = null;
    // Clear the previous directory immediately: keeping it clickable while the
    // request is in flight would let "Use this folder" apply the stale path.
    this.browserListing = null;
    void client
      .request<FsListDirResult>("fs.listDir", path ? { path } : {})
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
    return html`
      <div class="new-session-page__browser">
        <div class="new-session-page__browser-head">
          <button
            type="button"
            class="new-session-page__browser-nav"
            title=${t("newSession.browserUp")}
            aria-label=${t("newSession.browserUp")}
            ?disabled=${!listing?.parent}
            @click=${() => listing?.parent && this.loadBrowser(listing.parent)}
          >
            ${icons.arrowLeft}
          </button>
          <span class="new-session-page__browser-path"
            >${listing?.path ?? (this.browserLoading ? t("common.loading") : "")}</span
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
          ${listing && listing.entries.length === 0 && !this.browserLoading
            ? html`<div class="new-session-page__browser-empty">
                ${t("newSession.browserEmpty")}
              </div>`
            : nothing}
          ${(listing?.entries ?? []).map(
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
          )}
        </div>
        <div class="new-session-page__browser-actions">
          <button
            type="button"
            class="new-session-page__browser-use"
            ?disabled=${!listing}
            @click=${() => {
              if (listing) {
                this.applyFolder(listing.path);
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
        ${isAdmin && this.nodes.length > 0
          ? html`
              <label class="new-session-page__target" title=${t("newSession.where")}>
                <span class="new-session-page__target-icon" aria-hidden="true"
                  >${icons.monitor}</span
                >
                <select
                  aria-label=${t("newSession.where")}
                  .value=${this.execNode}
                  @change=${(event: Event) => {
                    this.execNode = (event.target as HTMLSelectElement).value;
                    if (this.execNode) {
                      this.closeBrowser();
                    }
                  }}
                >
                  <option value="" ?selected=${!this.execNode}>${t("newSession.gateway")}</option>
                  ${this.nodes.map(
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
            placeholder=${this.workspacePath() || t("newSession.folderPlaceholder")}
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
    `;
  }

  override render() {
    const worktreeNameInvalid =
      this.worktree &&
      this.worktreeName.trim() !== "" &&
      !WORKTREE_NAME_PATTERN.test(this.worktreeName.trim());
    return html`
      <div class="new-session-page">
        <div class="new-session-page__inner">
          <h1 class="new-session-page__title">${t("newSession.title")}</h1>
          <p class="new-session-page__hint">${t("newSession.hint")}</p>
          ${this.renderTargetBar()} ${this.renderBrowser()}
          ${worktreeNameInvalid
            ? html`<div class="new-session-page__error">
                ${t("newSession.worktreeNameInvalid")}
              </div>`
            : nothing}
          ${this.error ? html`<div class="new-session-page__error">${this.error}</div>` : nothing}
          <textarea
            class="new-session-page__message"
            rows="6"
            placeholder=${t("newSession.messagePlaceholder")}
            .value=${this.message}
            @input=${(event: Event) => {
              this.message = (event.target as HTMLTextAreaElement).value;
            }}
            @keydown=${(event: KeyboardEvent) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void this.submit();
              }
            }}
          ></textarea>
          <div class="new-session-page__actions">
            <button
              type="button"
              class="new-session-page__start"
              ?disabled=${!this.canSubmit()}
              @click=${() => void this.submit()}
            >
              ${this.submitting ? t("newSession.starting") : t("newSession.start")}
            </button>
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
