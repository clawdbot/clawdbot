import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type {
  FsListDirResult,
  WorktreeRepositoryStatus,
} from "../../../packages/gateway-protocol/src/index.js";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { renderSessionMenuItem } from "../pages/new-session/cloud-target.ts";
import { folderDisplayName } from "../pages/new-session/path.ts";
import { PlaceBrowserState } from "../pages/new-session/place-browser-state.ts";
import { renderPlaceBrowser } from "../pages/new-session/place-browser.ts";
import "../styles/new-session.css";
import { icons } from "./icons.ts";
import { withPromiseModalHost } from "./promise-modal-host.ts";
import { syncDropdownItemRadio } from "./web-awesome.ts";
import "./web-awesome-popover.ts";

export type SessionGroupDefaults = { cwd: string; worktree: boolean };

type Options = {
  group: string;
  defaults: SessionGroupDefaults;
  listDirectory: (path?: string) => Promise<FsListDirResult>;
  inspectRepository: (path?: string) => Promise<WorktreeRepositoryStatus>;
  submit: (defaults: SessionGroupDefaults) => Promise<string | null>;
};

let active = false;

export function showSessionGroupDefaultsDialog(options: Options): Promise<void> {
  if (active) {
    return Promise.resolve();
  }
  active = true;
  return withPromiseModalHost<void>(undefined, ({ host, render, finish: settle }) => {
    let cwd = options.defaults.cwd;
    let worktree = false;
    let repositoryStatus: WorktreeRepositoryStatus | "checking" = "checking";
    let repositoryRequestToken = 0;
    let submitting = false;
    let failure: string | null = null;
    let browserVisible = false;
    const browser = new PlaceBrowserState(options.listDirectory, paint);

    const finish = () => {
      browser.reset();
      repositoryRequestToken += 1;
      settle();
      active = false;
    };

    const handleSubmit = async (event: Event) => {
      event.preventDefault();
      if (submitting || repositoryStatus === "checking" || repositoryStatus === "unavailable") {
        return;
      }
      submitting = true;
      failure = null;
      paint();
      try {
        failure = await options.submit({
          cwd: cwd.trim(),
          worktree: repositoryStatus === "git" && worktree,
        });
      } catch (error) {
        failure = formatUiError(error);
      }
      if (!failure) {
        finish();
        return;
      }
      submitting = false;
      paint();
    };

    const closePicker = () => {
      const picker = host.querySelector<HTMLElement & { open: boolean }>(
        "wa-popover.session-group-defaults__folder-popover",
      );
      if (picker) {
        picker.open = false;
      }
    };

    const showPickerRoot = () => {
      browser.reset();
      browserVisible = false;
      paint();
    };

    const applyFolder = (path: string) => {
      cwd = path.trim();
      showPickerRoot();
      closePicker();
      void inspectRepository(false);
    };

    const inspectRepository = async (restoreSavedWorktree: boolean) => {
      const requestToken = ++repositoryRequestToken;
      repositoryStatus = "checking";
      worktree = false;
      failure = null;
      paint();
      try {
        const status = await options.inspectRepository(cwd.trim() || undefined);
        if (requestToken !== repositoryRequestToken) {
          return;
        }
        repositoryStatus = status;
        worktree = status === "git" && restoreSavedWorktree && options.defaults.worktree;
      } catch {
        if (requestToken !== repositoryRequestToken) {
          return;
        }
        repositoryStatus = "unavailable";
        worktree = false;
      }
      paint();
    };

    const selectWorktree = (value: boolean) => {
      worktree = value;
      failure = null;
      paint();
    };

    const handleModeSelect = (event: CustomEvent<{ item: Element }>) => {
      const value = event.detail.item.getAttribute("value");
      if (value !== "local" && value !== "worktree") {
        return;
      }
      selectWorktree(value === "worktree");
    };

    const focusSelectedMode = (event: Event) => {
      if (!(event.currentTarget instanceof HTMLElement)) {
        return;
      }
      const items = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement & { active: boolean }>(
          "wa-dropdown-item[data-environment-mode]",
        ),
      );
      const selected = items.find((item) => item.hasAttribute("data-selected")) ?? items[0];
      if (!selected) {
        return;
      }
      for (const item of items) {
        item.active = item === selected;
      }
      selected.focus({ preventScroll: true });
    };

    const handleModeKeydown = (event: KeyboardEvent) => {
      if (!(event.currentTarget instanceof HTMLElement)) {
        return;
      }
      const dropdown = event.currentTarget as HTMLElement & { open?: boolean };
      if (event.key !== "Escape" || !dropdown.open) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dropdown.open = false;
      dropdown
        .querySelector<HTMLElement>("#session-group-defaults-mode-trigger")
        ?.focus({ preventScroll: true });
    };

    const showBrowser = () => {
      browserVisible = true;
      void browser.navigate(cwd || undefined);
    };

    function paint() {
      const trimmedCwd = cwd.trim();
      const folderLabel = trimmedCwd
        ? folderDisplayName(trimmedCwd)
        : t("sessionsView.groupDefaultsCwdPlaceholder");
      const environmentState =
        repositoryStatus === "checking" ? "checking" : repositoryStatus === "git" ? "git" : "local";
      const environmentOptions = [
        {
          value: "local",
          label: t("sessionsView.groupDefaultsLocal"),
          description: t("newSession.checkoutCurrentNote"),
          icon: icons.monitor,
        },
        {
          value: "worktree",
          label: t("sessionsView.groupDefaultsWorktree"),
          description: t("sessionsView.groupDefaultsWorktreeHint"),
          icon: icons.gitBranch,
        },
      ] as const;
      const selectedEnvironment = environmentOptions[worktree ? 1 : 0];
      render(() => {
        return html`
          <openclaw-modal-dialog
            label=${t("sessionsView.groupDefaultsTitle", { group: options.group })}
            @modal-cancel=${(event: Event) => {
              if (submitting) {
                event.preventDefault();
                return;
              }
              finish();
            }}
          >
            <form class="exec-approval-card session-group-defaults" @submit=${handleSubmit}>
              <div class="exec-approval-header">
                <div>
                  <div class="exec-approval-title">
                    ${t("sessionsView.groupDefaultsTitle", { group: options.group })}
                  </div>
                  <div class="exec-approval-sub">${t("sessionsView.groupDefaultsDescription")}</div>
                </div>
              </div>
              <div class="session-group-defaults__fields">
                <div class="field">
                  <span>${t("sessionsView.groupDefaultsCwd")}</span>
                  <button
                    id="session-group-defaults-folder-trigger"
                    type="button"
                    class="new-session-page__trigger session-group-defaults__folder"
                    aria-label="${t("sessionsView.groupDefaultsCwd")}: ${folderLabel}"
                    aria-haspopup="dialog"
                    ?disabled=${submitting}
                  >
                    <span class="new-session-page__target-icon" aria-hidden="true"
                      >${icons.folder}</span
                    >
                    <span class="session-group-defaults__folder-copy">
                      <strong>${folderLabel}</strong>
                      <small title=${trimmedCwd || nothing}
                        >${trimmedCwd || t("sessionsView.groupDefaultsCwdHint")}</small
                      >
                    </span>
                    <span class="new-session-page__trigger-chevron" aria-hidden="true"
                      >${icons.chevronDown}</span
                    >
                  </button>
                  <wa-popover
                    class="new-session-page__select new-session-page__project-popover new-session-page__picker-popover session-group-defaults__folder-popover"
                    for="session-group-defaults-folder-trigger"
                    placement="bottom-start"
                    without-arrow
                    @wa-hide=${showPickerRoot}
                  >
                    ${
                      browserVisible
                        ? renderPlaceBrowser({
                            browser,
                            id: "session-group-defaults-browser",
                            label: t("newSession.gateway"),
                            registerProjectPath: null,
                            registeringProject: false,
                            onBack: showPickerRoot,
                            onRegisterProject: () => undefined,
                            onClose: showPickerRoot,
                            onApplyFolder: applyFolder,
                          })
                        : html`
                            <div class="new-session-page__picker-root">
                              ${renderSessionMenuItem(
                                {
                                  value: "agent-workspace",
                                  label: t("sessionsView.groupDefaultsCwdPlaceholder"),
                                  icon: icons.folder,
                                  checked: !trimmedCwd,
                                  onSelect: () => applyFolder(""),
                                },
                                submitting,
                              )}
                              <button
                                type="button"
                                class="session-menu__item"
                                data-value="browse"
                                aria-pressed="false"
                                ?disabled=${submitting}
                                @click=${showBrowser}
                              >
                                <span class="session-menu__check" aria-hidden="true"></span>
                                <span class="session-menu__text">${t("newSession.browse")}</span>
                                <span class="new-session-page__menu-chevron" aria-hidden="true"
                                  >${icons.chevronRight}</span
                                >
                              </button>
                            </div>
                          `
                    }
                  </wa-popover>
                </div>
                <div class="field">
                  <span>${t("sessionsView.groupDefaultsMode")}</span>
                  <div
                    class="session-group-defaults__environment"
                    data-session-group-environment=${environmentState}
                    aria-live="polite"
                  >
                    ${
                      repositoryStatus === "git"
                        ? html`
                            <wa-dropdown
                              class="session-group-defaults__mode-dropdown"
                              placement="bottom-start"
                              aria-label=${t("sessionsView.groupDefaultsMode")}
                              @wa-select=${handleModeSelect}
                              @wa-after-show=${focusSelectedMode}
                              @keydown=${handleModeKeydown}
                            >
                              <button
                                id="session-group-defaults-mode-trigger"
                                slot="trigger"
                                type="button"
                                class="session-group-defaults__resolved-mode session-group-defaults__mode-trigger"
                                data-value=${selectedEnvironment.value}
                                aria-label=${`${t("sessionsView.groupDefaultsMode")}: ${selectedEnvironment.label}`}
                                ?disabled=${submitting}
                              >
                                <span class="new-session-page__target-icon" aria-hidden="true"
                                  >${selectedEnvironment.icon}</span
                                >
                                <span class="session-group-defaults__resolved-copy">
                                  <strong>${selectedEnvironment.label}</strong>
                                  <small>${selectedEnvironment.description}</small>
                                </span>
                                <span class="new-session-page__trigger-chevron" aria-hidden="true"
                                  >${icons.chevronDown}</span
                                >
                              </button>
                              ${environmentOptions.map((option) => {
                                const selected = option === selectedEnvironment;
                                return html`
                                  <wa-dropdown-item
                                    class="session-group-defaults__mode-option"
                                    data-environment-mode=${option.value}
                                    ?data-selected=${selected}
                                    aria-label=${`${option.label}, ${option.description}`}
                                    value=${option.value}
                                    type="checkbox"
                                    .checked=${selected}
                                    ?disabled=${submitting}
                                    ${ref((element) => syncDropdownItemRadio(element, selected))}
                                  >
                                    <span
                                      slot="icon"
                                      class="new-session-page__target-icon session-group-defaults__mode-option-icon"
                                      aria-hidden="true"
                                      >${option.icon}</span
                                    >
                                    <span class="session-group-defaults__resolved-copy">
                                      <strong>${option.label}</strong>
                                      <small>${option.description}</small>
                                    </span>
                                  </wa-dropdown-item>
                                `;
                              })}
                            </wa-dropdown>
                          `
                        : html`
                            <div
                              class="session-group-defaults__resolved-mode"
                              role=${repositoryStatus === "checking" ? "status" : nothing}
                            >
                              <span class="new-session-page__target-icon" aria-hidden="true"
                                >${
                                  repositoryStatus === "checking" ? icons.gitBranch : icons.monitor
                                }</span
                              >
                              <span class="session-group-defaults__resolved-copy">
                                <strong
                                  >${
                                    repositoryStatus === "checking"
                                      ? t("newSession.checkingGit")
                                      : t("sessionsView.groupDefaultsLocal")
                                  }</strong
                                >
                                ${
                                  repositoryStatus === "checking"
                                    ? nothing
                                    : html`<small
                                        >${
                                          repositoryStatus === "unavailable"
                                            ? t("newSession.gitCheckUnavailable")
                                            : t("newSession.checkoutCurrentNote")
                                        }</small
                                      >`
                                }
                              </span>
                            </div>
                          `
                    }
                  </div>
                </div>
              </div>
              ${
                failure
                  ? html`<div class="exec-approval-error" role="alert">${failure}</div>`
                  : nothing
              }
              <div class="exec-approval-actions">
                <button
                  type="submit"
                  class="btn primary"
                  ?disabled=${
                    submitting ||
                    repositoryStatus === "checking" ||
                    repositoryStatus === "unavailable"
                  }
                >
                  ${t("common.save")}
                </button>
                ${
                  repositoryStatus === "unavailable"
                    ? html`
                        <button
                          type="button"
                          class="btn"
                          ?disabled=${submitting}
                          @click=${() =>
                            void inspectRepository(cwd.trim() === options.defaults.cwd.trim())}
                        >
                          ${t("common.retry")}
                        </button>
                      `
                    : nothing
                }
                <button type="button" class="btn" ?disabled=${submitting} @click=${finish}>
                  ${t("common.cancel")}
                </button>
              </div>
            </form>
          </openclaw-modal-dialog>
        `;
      });
    }

    void inspectRepository(true);
  });
}
