import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { renderSessionMenuItem } from "./cloud-target.ts";
import type { DraftBranches } from "./discovery.ts";

type CheckoutChipState = Readonly<{
  label: string;
}>;

export function resolveCheckoutChip(params: {
  destination: "local" | "remote";
  worktree: boolean;
  worktreeAvailable: boolean;
  headBranch?: string;
  baseRef: string;
}): CheckoutChipState | null {
  if (params.destination === "local" && !params.worktreeAvailable && !params.worktree) {
    return null;
  }
  if (!params.worktree) {
    return { label: params.headBranch || t("newSession.checkoutCurrent") };
  }
  return {
    label: params.baseRef
      ? t("newSession.checkoutWorktreeFrom", { branch: params.baseRef })
      : t("newSession.checkoutWorktree"),
  };
}

function renderWorktreeFields(
  params: {
    branches: DraftBranches | null;
    branchesLoading: boolean;
    baseRef: string;
    worktreeName: string;
    submitting: boolean;
    pendingPlacement: boolean;
    onBaseRefChange: (baseRef: string) => void;
    onWorktreeNameInput: (name: string) => void;
  },
  showWorktreeDetails: boolean,
) {
  return html`
    <label class="new-session-page__menu-field">
      <span>${t("newSession.worktreeBaseRef")}</span>
      <input
        type="text"
        list="new-session-branches"
        ?disabled=${params.submitting || params.pendingPlacement}
        placeholder=${params.branchesLoading
          ? t("common.loading")
          : (params.branches?.defaultBranch ?? t("newSession.worktreeBaseRef"))}
        .value=${params.baseRef}
        @change=${(event: Event) => {
          if (event.currentTarget instanceof HTMLInputElement) {
            params.onBaseRefChange(event.currentTarget.value.trim());
          }
        }}
      />
      <datalist id="new-session-branches">
        ${(params.branches?.branches ?? []).map(
          (branch) => html`<option value=${branch.name}></option>`,
        )}
      </datalist>
    </label>
    ${showWorktreeDetails
      ? html`<label class="new-session-page__menu-field">
            <span>${t("newSession.worktreeName")}</span>
            <input
              type="text"
              ?disabled=${params.submitting || params.pendingPlacement}
              placeholder=${t("newSession.worktreeNamePlaceholder")}
              .value=${params.worktreeName}
              @input=${(event: Event) => {
                if (event.currentTarget instanceof HTMLInputElement) {
                  params.onWorktreeNameInput(event.currentTarget.value.trim());
                }
              }}
            />
          </label>
          <div class="new-session-page__menu-note">${t("newSession.worktreeBranchNote")}</div>`
      : nothing}
  `;
}

export function renderCheckoutChip(params: {
  state: CheckoutChipState;
  remotePlacement: boolean;
  folderLabel: string;
  worktree: boolean;
  worktreeAvailable: boolean;
  allocationBlockedReason?: string;
  repositoryUnavailable?: boolean;
  branches: DraftBranches | null;
  branchesLoading: boolean;
  baseRef: string;
  worktreeName: string;
  submitting: boolean;
  pendingPlacement: boolean;
  popoverOpen: boolean;
  popoverHiding: boolean;
  onGuardTransition: (event: MouseEvent) => void;
  onPopoverShow: () => void;
  onPopoverHide: () => void;
  onPopoverAfterHide: () => void;
  onSelectWorktree: (value: boolean) => void;
  onManageWorktrees: () => void;
  onBaseRefChange: (baseRef: string) => void;
  onWorktreeNameInput: (name: string) => void;
}) {
  return html`
    <span class="new-session-page__select">
      <button
        id="new-session-checkout-trigger"
        type="button"
        class="new-session-page__trigger ${params.popoverHiding
          ? "new-session-page__trigger--hiding"
          : ""}"
        title=${t("newSession.checkout")}
        aria-label="${t("newSession.checkout")}: ${params.state.label}"
        data-worktree=${String(params.worktree)}
        aria-haspopup="dialog"
        aria-expanded=${String(params.popoverOpen)}
        ?disabled=${params.submitting || params.pendingPlacement}
        @click=${params.onGuardTransition}
      >
        <span class="new-session-page__target-icon" aria-hidden="true">${icons.gitBranch}</span>
        <span class="new-session-page__trigger-label">${params.state.label}</span>
        ${params.allocationBlockedReason
          ? html`<span class="new-session-page__capacity-badge"
              >${params.allocationBlockedReason}</span
            >`
          : nothing}
        <span
          class="new-session-page__trigger-chevron new-session-page__trigger-chevron--desktop"
          aria-hidden="true"
          >${icons.chevronDown}</span
        >
        <span
          class="new-session-page__trigger-chevron new-session-page__trigger-chevron--mobile"
          aria-hidden="true"
          >${icons.chevronsUpDown}</span
        >
      </button>
    </span>
    <wa-popover
      class="new-session-page__select new-session-page__checkout-popover new-session-page__picker-popover"
      for="new-session-checkout-trigger"
      placement="bottom-start"
      without-arrow
      @wa-show=${params.onPopoverShow}
      @wa-hide=${params.onPopoverHide}
      @wa-after-hide=${params.onPopoverAfterHide}
    >
      <div class="new-session-page__picker-root">
        <div class="new-session-page__menu-title">${t("newSession.checkout")}</div>
        ${renderSessionMenuItem(
          {
            value: "checkout",
            label: t("newSession.checkoutCurrent"),
            icon: icons.folder,
            sub: params.branches?.headBranch,
            checked: !params.worktree,
            disabled: params.remotePlacement,
            title: params.remotePlacement ? t("newSession.checkoutRemoteLocked") : undefined,
            onSelect: () => params.onSelectWorktree(false),
            keepOpen: true,
          },
          params.submitting,
        )}
        ${renderSessionMenuItem(
          {
            value: "worktree",
            label: t("newSession.checkoutWorktree"),
            icon: icons.gitBranch,
            sub: t("newSession.checkoutWorktreeSub"),
            checked: params.worktree,
            disabled: !params.worktreeAvailable || Boolean(params.allocationBlockedReason),
            title: params.allocationBlockedReason
              ? params.allocationBlockedReason
              : params.worktreeAvailable
                ? undefined
                : params.repositoryUnavailable
                  ? t("newSession.gitCheckUnavailable")
                  : t("newSession.worktreeUnavailable"),
            onSelect: () => params.onSelectWorktree(true),
            keepOpen: true,
          },
          params.submitting,
        )}
        ${params.allocationBlockedReason
          ? html`<button
              class="new-session-page__capacity-warning"
              type="button"
              @click=${params.onManageWorktrees}
            >
              ${params.allocationBlockedReason}. ${t("worktrees.title")}
            </button>`
          : nothing}
        ${params.worktree || params.allocationBlockedReason
          ? renderWorktreeFields(params, params.worktree)
          : nothing}
        ${params.remotePlacement
          ? html`<div class="new-session-page__menu-note">
              ${t("newSession.placementSyncsFolder", { folder: params.folderLabel })}
            </div>`
          : nothing}
      </div>
    </wa-popover>
  `;
}
