import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { renderSessionMenuItem } from "./cloud-target.ts";
import type { DraftBranches, DraftRepositoryState } from "./discovery.ts";

type DetailChipState = Readonly<{
  mode: "node" | "cloud" | "git" | "direct" | "checking" | "unavailable";
  label: string;
  worktreeLocked: boolean;
}>;

export function resolveDetailChip(params: {
  execNode: string;
  cloudProfileId: string;
  worktree: boolean;
  repository: DraftRepositoryState;
}): DetailChipState {
  if (params.execNode) {
    return { mode: "node", label: t("newSession.nodePath"), worktreeLocked: false };
  }
  if (params.cloudProfileId) {
    return { mode: "cloud", label: t("newSession.worktree"), worktreeLocked: true };
  }
  if (params.repository.kind === "git" || params.worktree) {
    return {
      mode: "git",
      label: params.worktree ? t("newSession.worktree") : t("newSession.runsDirectly"),
      worktreeLocked: false,
    };
  }
  if (params.repository.kind === "checking") {
    return { mode: "checking", label: t("newSession.checkingGit"), worktreeLocked: false };
  }
  if (params.repository.kind === "unavailable") {
    return {
      mode: "unavailable",
      label: t("newSession.runsDirectly"),
      worktreeLocked: false,
    };
  }
  return { mode: "direct", label: t("newSession.runsDirectly"), worktreeLocked: false };
}

export function renderDetailChip(params: {
  state: DetailChipState;
  syncLabel: string;
  folder: string;
  execNode: string;
  worktree: boolean;
  worktreeAvailable: boolean;
  worktreeDisabledReason?: string;
  branches: DraftBranches | null;
  branchesLoading: boolean;
  baseRef: string;
  worktreeName: string;
  submitting: boolean;
  pendingCloud: boolean;
  popoverOpen: boolean;
  popoverHiding: boolean;
  onGuardTransition: (event: MouseEvent) => void;
  onPopoverShow: () => void;
  onPopoverHide: () => void;
  onPopoverAfterHide: () => void;
  onToggleWorktree: () => void;
  onBaseRefInput: (baseRef: string) => void;
  onWorktreeNameInput: (name: string) => void;
  onNodeFolderInput: (folder: string, execNode: string) => void;
}) {
  const showWorktreeControls = params.state.mode === "git" || params.state.mode === "cloud";
  const worktreeEnabled = params.worktreeAvailable || params.worktree;
  return html`
    <span class="new-session-page__select">
      <button
        id="new-session-detail-trigger"
        type="button"
        class="new-session-page__trigger ${params.popoverHiding
          ? "new-session-page__trigger--hiding"
          : ""}"
        title=${t("newSession.detail")}
        aria-label="${t("newSession.detail")}: ${params.state.label}"
        data-worktree=${String(params.worktree)}
        aria-haspopup="dialog"
        aria-expanded=${String(params.popoverOpen)}
        ?disabled=${params.submitting || params.pendingCloud}
        @click=${params.onGuardTransition}
      >
        <span class="new-session-page__target-icon" aria-hidden="true"
          >${showWorktreeControls ? icons.gitBranch : icons.settings}</span
        >
        <span class="new-session-page__trigger-label">${params.state.label}</span>
        <span class="new-session-page__trigger-chevron" aria-hidden="true"
          >${icons.chevronDown}</span
        >
      </button>
    </span>
    <wa-popover
      class="new-session-page__select new-session-page__detail-popover new-session-page__picker-popover"
      for="new-session-detail-trigger"
      placement="bottom-start"
      without-arrow
      @wa-show=${params.onPopoverShow}
      @wa-hide=${params.onPopoverHide}
      @wa-after-hide=${params.onPopoverAfterHide}
    >
      <div class="new-session-page__picker-root">
        ${params.state.mode === "node"
          ? html`
              <label class="new-session-page__menu-field new-session-page__node-path">
                <span>${t("newSession.nodeCwd")}</span>
                <input
                  type="text"
                  ?disabled=${params.submitting || params.pendingCloud}
                  placeholder=${t("newSession.folderPlaceholder")}
                  .value=${params.folder}
                  @change=${(event: Event) =>
                    params.onNodeFolderInput(
                      (event.target as HTMLInputElement).value.trim(),
                      params.execNode,
                    )}
                  @keydown=${(event: KeyboardEvent) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      params.onNodeFolderInput(
                        (event.target as HTMLInputElement).value.trim(),
                        params.execNode,
                      );
                    }
                  }}
                />
              </label>
            `
          : showWorktreeControls
            ? html`
                ${renderSessionMenuItem(
                  {
                    value: "worktree",
                    label: t("newSession.worktree"),
                    checked: params.worktree,
                    disabled: params.state.worktreeLocked || !worktreeEnabled,
                    title: params.state.worktreeLocked
                      ? t("newSession.cloudRequiresWorktree")
                      : params.worktreeAvailable
                        ? t("chat.runControls.newSessionWorktree")
                        : (params.worktreeDisabledReason ?? t("newSession.worktreeUnavailable")),
                    onSelect: params.onToggleWorktree,
                    keepOpen: true,
                  },
                  params.submitting,
                )}
                ${params.state.worktreeLocked
                  ? html`<div class="new-session-page__menu-note">
                      ${t("newSession.cloudRequiresWorktree")}
                    </div>`
                  : nothing}
                ${params.state.mode === "cloud"
                  ? html`<div class="new-session-page__menu-note">
                      ${t("newSession.cloudSyncsFolder", { folder: params.syncLabel })}
                    </div>`
                  : nothing}
                ${params.worktree
                  ? html`
                      <label class="new-session-page__menu-field">
                        <span>${t("newSession.baseBranch")}</span>
                        <input
                          type="text"
                          list="new-session-branches"
                          ?disabled=${params.submitting || params.pendingCloud}
                          placeholder=${params.branchesLoading
                            ? t("common.loading")
                            : (params.branches?.defaultBranch ?? t("newSession.baseBranch"))}
                          .value=${params.baseRef}
                          @input=${(event: Event) =>
                            params.onBaseRefInput((event.target as HTMLInputElement).value.trim())}
                        />
                        <datalist id="new-session-branches">
                          ${(params.branches?.branches ?? []).map(
                            (branch) => html`<option value=${branch.name}></option>`,
                          )}
                        </datalist>
                      </label>
                      <label class="new-session-page__menu-field">
                        <span>${t("newSession.worktreeName")}</span>
                        <input
                          type="text"
                          ?disabled=${params.submitting || params.pendingCloud}
                          placeholder=${t("newSession.worktreeNamePlaceholder")}
                          .value=${params.worktreeName}
                          @input=${(event: Event) =>
                            params.onWorktreeNameInput(
                              (event.target as HTMLInputElement).value.trim(),
                            )}
                        />
                      </label>
                    `
                  : html`<div class="new-session-page__menu-note">
                      ${t("newSession.runsDirectlyNote")}
                    </div>`}
              `
            : html`<div class="new-session-page__menu-note">
                ${params.state.mode === "checking"
                  ? t("newSession.checkingGit")
                  : params.state.mode === "unavailable"
                    ? t("newSession.gitCheckUnavailable")
                    : t("newSession.runsDirectlyNote")}
              </div>`}
      </div>
    </wa-popover>
  `;
}
