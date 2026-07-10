// New-session draft dialog: pick agent, exec host, folder, and branch/worktree
// before the first message creates the session in one sessions.create call.
import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { RouteId } from "../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";

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

/** Maps the draft selections onto additive sessions.create params. */
export function buildDraftSessionCreateParams(draft: {
  agentId: string;
  message: string;
  worktree: boolean;
  baseRef?: string;
  worktreeName?: string;
  cwd?: string;
  workspace?: string;
  execNode?: string;
}): Record<string, unknown> {
  const cwd = normalizeOptionalString(draft.cwd);
  const workspace = normalizeOptionalString(draft.workspace);
  const customFolder = cwd && cwd !== workspace ? cwd : undefined;
  return {
    agentId: normalizeAgentId(draft.agentId),
    message: draft.message,
    ...(draft.worktree
      ? {
          worktree: true,
          // Passing the base explicitly also skips the create-time origin fetch.
          ...(normalizeOptionalString(draft.baseRef)
            ? { worktreeBaseRef: normalizeOptionalString(draft.baseRef) }
            : {}),
          ...(normalizeOptionalString(draft.worktreeName)
            ? { worktreeName: normalizeOptionalString(draft.worktreeName) }
            : {}),
          ...(customFolder ? { cwd: customFolder } : {}),
        }
      : {}),
    ...(normalizeOptionalString(draft.execNode)
      ? { execNode: normalizeOptionalString(draft.execNode) }
      : {}),
  };
}

class NewSessionDialog extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) open = false;
  @property({ attribute: false }) initialAgentId = "";
  @property({ attribute: false }) onClose?: () => void;
  @property({ attribute: false }) onCreated?: (sessionKey: string) => void;

  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext<RouteId>;

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

  private openedFor: string | null = null;
  private branchesRequestToken = 0;

  override updated() {
    if (!this.open) {
      this.openedFor = null;
      return;
    }
    const openKey = this.initialAgentId || "(default)";
    if (this.openedFor === openKey) {
      return;
    }
    this.openedFor = openKey;
    this.resetDraft();
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

  private resetDraft() {
    const agents = this.agents();
    const requested = normalizeAgentId(this.initialAgentId || "");
    const fallback = this.context?.agents.state.agentsList?.defaultId ?? agents[0]?.id ?? "main";
    this.agentId = agents.some((agent) => normalizeAgentId(agent.id) === requested)
      ? requested
      : normalizeAgentId(fallback);
    this.folder = this.workspacePath();
    this.worktree = false;
    this.worktreeName = "";
    this.baseRef = "";
    this.branches = null;
    this.branchesLoading = false;
    this.execNode = "";
    this.message = "";
    this.submitting = false;
    this.error = null;
    void this.loadNodes();
    this.maybeLoadBranches();
    void this.updateComplete.then(() => {
      this.querySelector<HTMLTextAreaElement>(".new-session-dialog__message")?.focus();
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
    const token = ++this.branchesRequestToken;
    this.branchesLoading = true;
    void client
      .request<DraftBranches>("worktrees.branches", { repoRoot })
      .then((result) => {
        if (token !== this.branchesRequestToken) {
          return;
        }
        this.branches = result ? { ...result, repoRoot } : null;
        this.baseRef = result?.defaultBranch ?? result?.headBranch ?? "";
      })
      .catch(() => {
        if (token === this.branchesRequestToken) {
          this.branches = null;
        }
      })
      .finally(() => {
        if (token === this.branchesRequestToken) {
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
      this.onCreated?.(key);
    } finally {
      this.submitting = false;
    }
  }

  private selectAgentId(agentId: string) {
    this.agentId = normalizeAgentId(agentId);
    this.folder = this.workspacePath();
    this.worktree = false;
    this.worktreeName = "";
    this.maybeLoadBranches();
  }

  private renderTargetBar() {
    const agents = this.agents();
    const isAdmin = this.isAdmin();
    const customFolder = this.usesCustomFolder();
    const worktreeAvailable = this.worktreeAvailable();
    const branches = this.branches;
    return html`
      <div class="new-session-dialog__targets">
        ${agents.length > 1
          ? html`
              <label class="new-session-dialog__target" title=${t("newSession.agent")}>
                <span class="new-session-dialog__target-icon" aria-hidden="true">${icons.bot}</span>
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
              <label class="new-session-dialog__target" title=${t("newSession.where")}>
                <span class="new-session-dialog__target-icon" aria-hidden="true"
                  >${icons.monitor}</span
                >
                <select
                  aria-label=${t("newSession.where")}
                  .value=${this.execNode}
                  @change=${(event: Event) => {
                    this.execNode = (event.target as HTMLSelectElement).value;
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
          class="new-session-dialog__target new-session-dialog__target--folder"
          title=${t("newSession.folder")}
        >
          <span class="new-session-dialog__target-icon" aria-hidden="true">${icons.folder}</span>
          <input
            type="text"
            aria-label=${t("newSession.folder")}
            placeholder=${this.workspacePath() || t("newSession.folderPlaceholder")}
            .value=${this.folder}
            ?disabled=${!isAdmin}
            @change=${(event: Event) => {
              this.folder = (event.target as HTMLInputElement).value.trim();
              if (this.usesCustomFolder()) {
                // Explicit host paths only materialize through a managed worktree.
                this.worktree = true;
              }
              this.maybeLoadBranches();
            }}
          />
        </label>
        <label
          class="new-session-dialog__target new-session-dialog__target--toggle"
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
          <span class="new-session-dialog__target-icon" aria-hidden="true">${icons.gitBranch}</span>
          <span>${t("newSession.worktree")}</span>
        </label>
        ${this.worktree
          ? html`
              <label class="new-session-dialog__target" title=${t("newSession.baseBranch")}>
                <input
                  type="text"
                  list="new-session-branches"
                  class="new-session-dialog__branch"
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
              <label class="new-session-dialog__target" title=${t("newSession.worktreeName")}>
                <input
                  type="text"
                  class="new-session-dialog__branch"
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
    if (!this.open) {
      return nothing;
    }
    const worktreeNameInvalid =
      this.worktree &&
      this.worktreeName.trim() !== "" &&
      !WORKTREE_NAME_PATTERN.test(this.worktreeName.trim());
    return html`
      <div
        class="new-session-dialog__backdrop"
        @click=${(event: MouseEvent) => {
          if (event.target === event.currentTarget) {
            this.onClose?.();
          }
        }}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            this.onClose?.();
          }
        }}
      >
        <div class="new-session-dialog" role="dialog" aria-label=${t("newSession.title")}>
          <div class="new-session-dialog__head">
            <span class="new-session-dialog__title">${t("newSession.title")}</span>
            <span class="new-session-dialog__hint">${t("newSession.hint")}</span>
            <button
              type="button"
              class="new-session-dialog__close"
              aria-label=${t("common.close")}
              @click=${() => this.onClose?.()}
            >
              ${icons.x}
            </button>
          </div>
          ${this.renderTargetBar()}
          ${worktreeNameInvalid
            ? html`<div class="new-session-dialog__error">
                ${t("newSession.worktreeNameInvalid")}
              </div>`
            : nothing}
          ${this.error ? html`<div class="new-session-dialog__error">${this.error}</div>` : nothing}
          <textarea
            class="new-session-dialog__message"
            rows="4"
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
          <div class="new-session-dialog__actions">
            <button
              type="button"
              class="new-session-dialog__cancel"
              @click=${() => this.onClose?.()}
            >
              ${t("common.cancel")}
            </button>
            <button
              type="button"
              class="new-session-dialog__start"
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

if (!customElements.get("openclaw-new-session-dialog")) {
  customElements.define("openclaw-new-session-dialog", NewSessionDialog);
}

export type { NewSessionDialog };
