import { readMissingScopeError } from "@openclaw/gateway-client/browser";
import { html, nothing, render } from "lit";
import type { FsListDirResult } from "../../../packages/gateway-protocol/src/index.js";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { renderSessionMenuItem } from "../pages/new-session/cloud-target.ts";
import type { BrowserTarget } from "../pages/new-session/discovery.ts";
import { folderDisplayName, isAbsolutePath } from "../pages/new-session/path.ts";
import { renderPlaceBrowser } from "../pages/new-session/place-browser.ts";
import "../styles/new-session.css";
import { icons } from "./icons.ts";
import "./modal-dialog.ts";
import "./web-awesome-popover.ts";

export type SessionGroupDefaults = { cwd: string; worktree: boolean };

type Options = {
  group: string;
  defaults: SessionGroupDefaults;
  listDirectory: (path?: string) => Promise<FsListDirResult>;
  submit: (defaults: SessionGroupDefaults) => Promise<string | null>;
};

let active = false;

export function showSessionGroupDefaultsDialog(options: Options): Promise<void> {
  if (active) {
    return Promise.resolve();
  }
  active = true;
  const host = document.createElement("div");
  document.body.append(host);
  return new Promise<void>((resolve) => {
    let cwd = options.defaults.cwd;
    let submitting = false;
    let failure: string | null = null;
    let browserVisible = false;
    let browserLoading = false;
    let browserError: string | null = null;
    let browserListing: FsListDirResult | null = null;
    let browserPathDraft = "";
    let browserRequestToken = 0;
    const browserTarget: BrowserTarget = { nodeId: "", label: t("newSession.gateway") };

    const finish = () => {
      browserRequestToken += 1;
      render(nothing, host);
      host.remove();
      active = false;
      resolve();
    };

    const handleSubmit = async (event: Event) => {
      event.preventDefault();
      if (submitting) {
        return;
      }
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      submitting = true;
      failure = null;
      paint();
      try {
        failure = await options.submit({
          cwd: cwd.trim(),
          worktree: data.get("mode") === "worktree",
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
      browserRequestToken += 1;
      browserVisible = false;
      browserLoading = false;
      browserError = null;
      browserListing = null;
      browserPathDraft = "";
      paint();
    };

    const applyFolder = (path: string) => {
      cwd = path.trim();
      showPickerRoot();
      closePicker();
    };

    const loadDirectory = async (path?: string) => {
      const requestToken = ++browserRequestToken;
      const requestedPath = path?.trim() || undefined;
      browserLoading = true;
      browserError = null;
      browserListing = null;
      browserPathDraft = requestedPath ?? "";
      paint();
      try {
        const listing = await options.listDirectory(requestedPath);
        if (requestToken !== browserRequestToken) {
          return;
        }
        browserListing = listing;
        if (listing.path && browserPathDraft === (requestedPath ?? "")) {
          browserPathDraft = listing.path;
        }
      } catch (error) {
        if (requestToken !== browserRequestToken) {
          return;
        }
        browserError = readMissingScopeError(error)?.missingScope
          ? t("newSession.browseRequiresAdmin")
          : formatUiError(error, t("newSession.browserLoadFailed"));
      } finally {
        if (requestToken === browserRequestToken) {
          browserLoading = false;
          paint();
        }
      }
    };

    const showBrowser = () => {
      browserVisible = true;
      void loadDirectory(cwd || undefined);
    };

    function paint() {
      const trimmedCwd = cwd.trim();
      const folderLabel = trimmedCwd
        ? folderDisplayName(trimmedCwd)
        : t("sessionsView.groupDefaultsCwdPlaceholder");
      const usableBrowserPath = isAbsolutePath(browserPathDraft.trim())
        ? browserPathDraft.trim()
        : null;
      render(
        html`
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
            <form class="exec-approval-card" @submit=${handleSubmit}>
              <div class="exec-approval-header">
                <div class="exec-approval-title">
                  ${t("sessionsView.groupDefaultsTitle", { group: options.group })}
                </div>
              </div>
              <div class="field">
                <span>${t("sessionsView.groupDefaultsCwd")}</span>
                <span class="new-session-page__select">
                  <button
                    id="session-group-defaults-folder-trigger"
                    type="button"
                    class="new-session-page__trigger"
                    aria-label="${t("sessionsView.groupDefaultsCwd")}: ${folderLabel}"
                    aria-haspopup="dialog"
                    ?disabled=${submitting}
                  >
                    <span class="new-session-page__target-icon" aria-hidden="true"
                      >${icons.folder}</span
                    >
                    <span class="new-session-page__trigger-label">${folderLabel}</span>
                    <span class="new-session-page__trigger-chevron" aria-hidden="true"
                      >${icons.chevronDown}</span
                    >
                  </button>
                </span>
                <wa-popover
                  class="new-session-page__select new-session-page__project-popover new-session-page__picker-popover session-group-defaults__folder-popover"
                  for="session-group-defaults-folder-trigger"
                  placement="bottom-start"
                  without-arrow
                  @wa-hide=${showPickerRoot}
                >
                  ${browserVisible
                    ? renderPlaceBrowser({
                        listing: browserListing,
                        target: browserTarget,
                        loading: browserLoading,
                        error: browserError,
                        pathDraft: browserPathDraft,
                        usablePath: usableBrowserPath,
                        registerProjectPath: null,
                        registeringProject: false,
                        onPathDraftChange: (value) => {
                          browserPathDraft = value;
                          paint();
                        },
                        onNavigate: (path) => void loadDirectory(path),
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
                      `}
                </wa-popover>
                <span class="muted" title=${trimmedCwd || nothing}
                  >${trimmedCwd || t("sessionsView.groupDefaultsCwdHint")}</span
                >
              </div>
              <label class="field">
                <span>${t("sessionsView.groupDefaultsMode")}</span>
                <select name="mode" ?disabled=${submitting}>
                  <option value="local" ?selected=${!options.defaults.worktree}>
                    ${t("sessionsView.groupDefaultsLocal")}
                  </option>
                  <option value="worktree" ?selected=${options.defaults.worktree}>
                    ${t("sessionsView.groupDefaultsWorktree")}
                  </option>
                </select>
              </label>
              ${failure
                ? html`<div class="exec-approval-error" role="alert">${failure}</div>`
                : nothing}
              <div class="exec-approval-actions">
                <button type="submit" class="btn primary" ?disabled=${submitting}>
                  ${t("common.save")}
                </button>
                <button type="button" class="btn" ?disabled=${submitting} @click=${finish}>
                  ${t("common.cancel")}
                </button>
              </div>
            </form>
          </openclaw-modal-dialog>
        `,
        host,
      );
    }

    paint();
  });
}
