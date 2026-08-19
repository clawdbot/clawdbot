import { html } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { renderSessionMenuItem } from "./cloud-target.ts";
import type { DraftBranches } from "./discovery.ts";

type DetailChipState = Readonly<{
  label: string;
}>;

export function resolveDetailChip(params: {
  destination: "local" | "remote";
  worktree: boolean;
  worktreeAvailable: boolean;
}): DetailChipState | null {
  if (params.destination === "remote" || (!params.worktreeAvailable && !params.worktree)) {
    return null;
  }
  return {
    label: params.worktree ? t("newSession.worktree") : t("newSession.runsDirectly"),
  };
}

export function renderWorktreeFields(params: {
  branches: DraftBranches | null;
  branchesLoading: boolean;
  baseRef: string;
  worktreeName: string;
  worktreeNameLabel?: string;
  submitting: boolean;
  pendingCloud: boolean;
  onBaseRefInput: (baseRef: string) => void;
  onWorktreeNameInput: (name: string) => void;
}) {
  return html`
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
      <span>${params.worktreeNameLabel ?? t("newSession.worktreeName")}</span>
      <input
        type="text"
        ?disabled=${params.submitting || params.pendingCloud}
        placeholder=${t("newSession.worktreeNamePlaceholder")}
        .value=${params.worktreeName}
        @input=${(event: Event) =>
          params.onWorktreeNameInput((event.target as HTMLInputElement).value.trim())}
      />
    </label>
  `;
}

export function renderDetailChip(params: {
  state: DetailChipState;
  worktree: boolean;
  worktreeAvailable: boolean;
  repositoryUnavailable?: boolean;
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
}) {
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
        <span class="new-session-page__target-icon" aria-hidden="true">${icons.gitBranch}</span>
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
        <div class="new-session-page__menu-title">${t("newSession.branches")}</div>
        ${renderSessionMenuItem(
          {
            value: "worktree",
            label: t("newSession.worktree"),
            checked: params.worktree,
            disabled: !worktreeEnabled,
            title: params.worktreeAvailable
              ? t("chat.runControls.newSessionWorktree")
              : params.repositoryUnavailable
                ? t("newSession.gitCheckUnavailable")
                : t("newSession.worktreeUnavailable"),
            onSelect: params.onToggleWorktree,
            keepOpen: true,
          },
          params.submitting,
        )}
        ${params.worktree
          ? renderWorktreeFields(params)
          : html`<div class="new-session-page__menu-note">
              ${t("newSession.runsDirectlyNote")}
            </div>`}
      </div>
    </wa-popover>
  `;
}
