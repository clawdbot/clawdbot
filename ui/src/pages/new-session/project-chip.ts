import { html, nothing } from "lit";
import type {
  ProjectRecord,
  ProjectRecent,
  RemoteProject,
} from "../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { renderSessionMenuItem } from "./cloud-target.ts";
import { folderDisplayName, parentFolderDisplayName } from "./path.ts";
import type { PlaceBrowserState } from "./place-browser-state.ts";
import { renderPlaceBrowser } from "./place-browser.ts";
import { disambiguate } from "./place-labels.ts";

/** Detects pasted clone URLs; the Gateway remains authoritative for host validation. */
export function projectCloneInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-") || /\s/u.test(trimmed)) {
    return null;
  }
  return /^(?:https:\/\/|ssh:\/\/git@|git@[^:]+:)/iu.test(trimmed) ? trimmed : null;
}

export type DraftRemoteProject = Readonly<{
  identity: string;
  cloneUrl: string;
  projectId?: string;
}>;

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : "";
}

type ProjectChipState = Readonly<{
  label: string;
  localProjects: readonly ProjectRecord[];
  recents: readonly ProjectRecent[];
  showWorkspace: boolean;
}>;

export function resolveProjectChip(params: {
  folder: string;
  workspace: string;
  projectId: string;
  selectedRemoteProject: DraftRemoteProject | null;
  projects: readonly ProjectRecord[];
  recents: readonly ProjectRecent[];
  projectQuery: string;
}): ProjectChipState {
  const folder = params.folder.trim();
  const selectedProject = params.projects.find((project) => project.id === params.projectId);
  const normalizedQuery = params.projectQuery.trim().toLowerCase();
  const localProjects = normalizedQuery
    ? params.projects.filter((project) =>
        [project.displayName, project.originUrl ?? "", project.repoRoot ?? ""]
          .join("\n")
          .toLowerCase()
          .includes(normalizedQuery),
      )
    : params.projects;
  return {
    label: selectedProject
      ? selectedProject.displayName
      : params.selectedRemoteProject?.identity
        ? params.selectedRemoteProject.identity
        : folder
          ? folderDisplayName(folder)
          : folderDisplayName(params.workspace) || t("newSession.folderPlaceholder"),
    localProjects,
    recents: normalizedQuery ? [] : params.recents.filter((recent) => recent.kind !== "project"),
    showWorkspace:
      !normalizedQuery ||
      [folderDisplayName(params.workspace), params.workspace]
        .join("\n")
        .toLowerCase()
        .includes(normalizedQuery),
  };
}

export function renderProjectChip(params: {
  state: ProjectChipState;
  browseAvailable: boolean;
  isAdmin: boolean;
  canWrite: boolean;
  folder: string;
  workspace: string;
  projects: readonly ProjectRecord[];
  projectQuery: string;
  projectSearchAvailable: boolean;
  projectAddAvailable: boolean;
  remoteProjects: readonly RemoteProject[];
  selectedRemoteProject: DraftRemoteProject | null;
  projectSearchCredentialMissing: boolean;
  projectSearchLoading: boolean;
  projectSearchError: string | null;
  projectId: string;
  gatewayLabel: string;
  submitting: boolean;
  pendingPlacement: boolean;
  popoverOpen: boolean;
  popoverHiding: boolean;
  browserOpen: boolean;
  browser: PlaceBrowserState;
  registerProjectPath: string | null;
  registeringProject: boolean;
  onGuardTransition: (event: MouseEvent) => void;
  onPopoverShow: () => void;
  onPopoverHide: () => void;
  onPopoverAfterHide: () => void;
  onSelectProject: (projectId: string) => void;
  onProjectQueryInput: (query: string) => void;
  onSelectRemoteProject: (project: DraftRemoteProject) => void;
  onApplyFolder: (folder: string) => void;
  onBrowse: () => void;
  onBrowserBack: () => void;
  onRegisterProject: (path: string) => void;
  onClose: () => void;
}) {
  const folder = params.folder.trim();
  const cloneInput = projectCloneInput(params.projectQuery);
  const query = params.projectQuery.trim();
  const browseNeedsAdmin = !params.browseAvailable && !params.isAdmin;
  const recentItems = params.state.recents;
  const recentSuffixes = disambiguate(recentItems, (recent) => recent.displayName, [
    (recent) => (recent.kind === "folder" ? parentFolderDisplayName(recent.folder) : undefined),
    (recent) => (recent.kind === "folder" ? recent.folder : undefined),
    (recent) =>
      recent.kind === "folder"
        ? recent.folder
        : recent.kind === "repository"
          ? recent.url
          : recent.projectId,
  ]);
  const browseButton = html`
    <button
      type="button"
      class="session-menu__item"
      data-value="browse"
      aria-pressed="false"
      aria-disabled=${browseNeedsAdmin ? "true" : nothing}
      ?disabled=${
        params.submitting ||
        params.pendingPlacement ||
        (!params.browseAvailable && !browseNeedsAdmin)
      }
      @click=${() => {
        if (params.browseAvailable && !params.submitting && !params.pendingPlacement) {
          params.onBrowse();
        }
      }}
    >
      <span class="session-menu__check" aria-hidden="true"></span>
      <span class="session-menu__text">${t("newSession.browse")}</span>
      <span class="new-session-page__menu-chevron" aria-hidden="true">${icons.chevronRight}</span>
    </button>
  `;

  return html`
    <span class="new-session-page__select">
      <button
        id="new-session-project-trigger"
        type="button"
        class="new-session-page__trigger ${
          params.popoverHiding ? "new-session-page__trigger--hiding" : ""
        }"
        title=${t("newSession.what")}
        aria-label="${t("newSession.what")}: ${params.state.label}"
        data-project-id=${params.projectId || nothing}
        aria-haspopup="dialog"
        aria-expanded=${String(params.popoverOpen)}
        ?disabled=${params.submitting || params.pendingPlacement}
        @click=${params.onGuardTransition}
      >
        <span class="new-session-page__target-icon" aria-hidden="true"
          >${params.projectId ? icons.gitBranch : icons.folder}</span
        >
        <span class="new-session-page__trigger-label">${params.state.label}</span>
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
      class="new-session-page__select new-session-page__project-popover new-session-page__picker-popover"
      for="new-session-project-trigger"
      placement="bottom-start"
      without-arrow
      @wa-show=${params.onPopoverShow}
      @wa-hide=${params.onPopoverHide}
      @wa-after-hide=${params.onPopoverAfterHide}
    >
      ${
        params.browserOpen
          ? renderPlaceBrowser({
              browser: params.browser,
              id: "new-session-place-browser",
              label: params.gatewayLabel,
              registerProjectPath: params.registerProjectPath,
              registeringProject: params.registeringProject,
              onBack: params.onBrowserBack,
              onRegisterProject: params.onRegisterProject,
              onClose: params.onClose,
              onApplyFolder: params.onApplyFolder,
            })
          : html`
              <div class="new-session-page__picker-root">
                <div class="new-session-page__menu-title">${t("newSession.projects")}</div>
                ${html`
                  ${
                    params.workspace && params.state.showWorkspace
                      ? renderSessionMenuItem(
                          {
                            value: "workspace",
                            label: folderDisplayName(params.workspace),
                            icon: icons.folder,
                            checked: !params.projectId && folder === params.workspace,
                            onSelect: () => params.onApplyFolder(params.workspace),
                          },
                          params.submitting,
                        )
                      : nothing
                  }
                  <label class="new-session-page__project-search">
                    <span class="sr-only">${t("newSession.projectSearchPlaceholder")}</span>
                    <input
                      type="search"
                      placeholder=${t("newSession.projectSearchPlaceholder")}
                      .value=${params.projectQuery}
                      ?disabled=${params.submitting || params.pendingPlacement}
                      @input=${(event: Event) => params.onProjectQueryInput(inputValue(event))}
                      @keydown=${(event: KeyboardEvent) => {
                        if (event.key === "Enter" && cloneInput && params.projectAddAvailable) {
                          event.preventDefault();
                          params.onSelectRemoteProject({
                            identity: cloneInput,
                            cloneUrl: cloneInput,
                          });
                        }
                      }}
                    />
                  </label>
                  ${params.state.localProjects.map((project) =>
                    renderSessionMenuItem(
                      {
                        value: `project:${project.id}`,
                        label: project.displayName,
                        icon: icons.gitBranch,
                        checked: params.projectId === project.id,
                        title: project.repoRoot,
                        onSelect: () => params.onSelectProject(project.id),
                      },
                      params.submitting,
                    ),
                  )}
                  ${
                    cloneInput && params.projectAddAvailable
                      ? renderSessionMenuItem(
                          {
                            value: "project-clone-url",
                            label: cloneInput,
                            icon: icons.gitBranch,
                            sub: t("newSession.cloneProject"),
                            checked: params.selectedRemoteProject?.cloneUrl === cloneInput,
                            onSelect: () =>
                              params.onSelectRemoteProject({
                                identity: cloneInput,
                                cloneUrl: cloneInput,
                              }),
                          },
                          params.submitting,
                        )
                      : nothing
                  }
                  ${
                    !cloneInput && query.length >= 2 && params.projectSearchAvailable
                      ? html`
                          <div class="new-session-page__menu-title">
                            ${t("newSession.githubProjects")}
                          </div>
                          ${
                            params.projectSearchCredentialMissing
                              ? html`<div class="new-session-page__menu-note">
                                  ${t("newSession.githubTokenHint")}
                                </div>`
                              : nothing
                          }
                          ${
                            params.projectSearchLoading
                              ? html`<div class="new-session-page__project-status" role="status">
                                  ${t("common.loading")}
                                </div>`
                              : nothing
                          }
                          ${
                            params.projectSearchError
                              ? html`<div class="new-session-page__project-error" role="alert">
                                  ${params.projectSearchError}
                                </div>`
                              : nothing
                          }
                          ${params.remoteProjects.map((project) =>
                            renderSessionMenuItem(
                              {
                                value: `remote-project:${project.fullName}`,
                                label: project.fullName,
                                icon: icons.gitBranch,
                                sub: project.description ?? t("newSession.cloneProject"),
                                checked:
                                  params.selectedRemoteProject?.cloneUrl === project.cloneUrl,
                                title: project.webUrl,
                                onSelect: () =>
                                  params.onSelectRemoteProject({
                                    identity: project.fullName,
                                    cloneUrl: project.cloneUrl,
                                  }),
                              },
                              params.submitting || !params.projectAddAvailable,
                            ),
                          )}
                        `
                      : nothing
                  }
                  ${
                    params.projects.length === 0 && params.canWrite && !params.isAdmin
                      ? html`<div class="new-session-page__menu-note">
                          ${t("newSession.projectsAdminHint")}
                        </div>`
                      : nothing
                  }
                `}
                ${
                  params.state.recents.length > 0
                    ? html`
                        <div class="new-session-page__menu-title">
                          ${t("newSession.recentFolders")}
                        </div>
                        ${recentItems.map((recent, index) =>
                          renderSessionMenuItem(
                            {
                              value:
                                recent.kind === "project"
                                  ? `recent-project:${recent.projectId}`
                                  : recent.kind === "repository"
                                    ? `repository:${recent.url}`
                                    : `recent:${recent.folder}`,
                              label: recent.displayName,
                              icon: recent.kind === "folder" ? icons.folder : icons.gitBranch,
                              sub: recentSuffixes[index],
                              checked:
                                recent.kind === "project"
                                  ? params.projectId === recent.projectId
                                  : recent.kind === "repository"
                                    ? params.selectedRemoteProject?.cloneUrl === recent.url
                                    : !params.projectId && folder === recent.folder,
                              title:
                                recent.kind === "project"
                                  ? undefined
                                  : recent.kind === "repository"
                                    ? recent.url
                                    : recent.folder,
                              onSelect: () =>
                                recent.kind === "project"
                                  ? params.onSelectProject(recent.projectId)
                                  : recent.kind === "repository"
                                    ? params.onSelectRemoteProject({
                                        identity: recent.displayName,
                                        cloneUrl: recent.url,
                                      })
                                    : params.onApplyFolder(recent.folder),
                            },
                            params.submitting,
                          ),
                        )}
                      `
                    : nothing
                }
                ${
                  browseNeedsAdmin
                    ? html`<openclaw-tooltip .content=${t("newSession.browseRequiresAdmin")}>
                        ${browseButton}
                      </openclaw-tooltip>`
                    : browseButton
                }
              </div>
            `
      }
    </wa-popover>
  `;
}
