import { html, nothing } from "lit";
import type {
  FsListDirResult,
  ProjectRecord,
  ProjectRecent,
  RemoteProject,
} from "../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import {
  renderCloudProfileMenuItems,
  renderConnectMachineMenuItem,
  renderSessionMenuItem,
} from "./cloud-target.ts";
import type {
  BrowserTarget,
  DraftBranches,
  DraftCloudProfile,
  DraftEnvironment,
  DraftNode,
} from "./discovery.ts";
import { folderDisplayName } from "./path.ts";
import { renderPlaceBrowser } from "./place-browser.ts";
import { disambiguate, isPhoneFamily, nodeTooltip } from "./place-labels.ts";
import { resolvePlacePickerSections } from "./place-picker-sections.ts";

function parentFolderDisplayName(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/u, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separator < 0) {
    return undefined;
  }
  const parent = separator === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, separator);
  return folderDisplayName(parent) || undefined;
}

/** Detects pasted clone URLs; the Gateway remains authoritative for host validation. */
export function projectCloneInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-") || /\s/u.test(trimmed)) {
    return null;
  }
  return /^(?:https:\/\/|ssh:\/\/git@|git@[^:]+:)/iu.test(trimmed) ? trimmed : null;
}

export function renderPlaceSelect(params: {
  browseAvailable: boolean;
  isAdmin: boolean;
  canWrite: boolean;
  folder: string;
  workspace: string;
  projects: readonly ProjectRecord[];
  recents: readonly ProjectRecent[];
  projectQuery: string;
  projectSearchAvailable: boolean;
  projectAddAvailable: boolean;
  remoteProjects: readonly RemoteProject[];
  projectSearchCredential: "configured" | "missing" | null;
  projectSearchLoading: boolean;
  projectSearchError: string | null;
  projectCloneBusy: boolean;
  projectCloneError: string | null;
  projectId: string;
  execNodes: DraftNode[];
  environments: readonly DraftEnvironment[] | null;
  gatewayName: string;
  cloudProfiles: readonly DraftCloudProfile[];
  cloudProfileId: string;
  execNode: string;
  syncFolder: string;
  worktree: boolean;
  worktreeVisible: boolean;
  worktreeAvailable: boolean;
  worktreeDisabledReason?: string;
  cloudDisabledReason?: string;
  branches: DraftBranches | null;
  branchesLoading: boolean;
  baseRef: string;
  worktreeName: string;
  submitting: boolean;
  pendingCloud: boolean;
  showDestinations: boolean;
  popoverOpen: boolean;
  popoverHiding: boolean;
  browserTarget: BrowserTarget | null;
  browserListing: FsListDirResult | null;
  browserLoading: boolean;
  browserError: string | null;
  browserPathDraft: string;
  usableBrowserPath: string | null;
  registerProjectPath: string | null;
  registeringProject: boolean;
  onGuardTransition: (event: MouseEvent) => void;
  onPopoverShow: () => void;
  onPopoverHide: () => void;
  onPopoverAfterHide: () => void;
  onSelectExecNode: (nodeId: string) => void;
  onSelectCloudProfile: (profileId: string) => void;
  onSelectProject: (projectId: string) => void;
  onProjectQueryInput: (query: string) => void;
  onCloneProject: (gitUrl: string) => void;
  onApplyFolder: (folder: string, execNode: string) => void;
  onBrowse: (target: BrowserTarget) => void;
  onBrowserPathDraftChange: (value: string) => void;
  onBrowserNavigate: (path: string | undefined) => void;
  onBrowserBack: () => void;
  onRegisterProject: (path: string) => void;
  onConnectMachine: () => void;
  onClose: () => void;
  onToggleWorktree: () => void;
  onBaseRefInput: (baseRef: string) => void;
  onWorktreeNameInput: (name: string) => void;
}) {
  const folder = params.folder.trim();
  const projectQuery = params.projectQuery.trim();
  const cloneInput = projectCloneInput(params.projectQuery);
  const normalizedProjectQuery = projectQuery.toLowerCase();
  const localProjects = normalizedProjectQuery
    ? params.projects.filter((project) =>
        [project.displayName, project.originUrl ?? "", project.repoRoot ?? ""]
          .join("\n")
          .toLowerCase()
          .includes(normalizedProjectQuery),
      )
    : params.projects;
  const selectedProject = params.projects.find((project) => project.id === params.projectId);
  const folderLabel = selectedProject
    ? selectedProject.displayName
    : folder
      ? folderDisplayName(folder)
      : params.execNode
        ? t("newSession.folderPlaceholder")
        : folderDisplayName(params.workspace) || t("newSession.folderPlaceholder");
  const activeNode = params.execNodes.find((node) => node.nodeId === params.execNode);
  const activeProfile = params.cloudProfiles.find(
    (profile) => profile.id === params.cloudProfileId,
  );
  const { deviceNodes, deviceFacts, cloudProfiles } = resolvePlacePickerSections(params);
  const gatewayLabel = params.gatewayName
    ? t("newSession.gatewayNamed", { name: params.gatewayName })
    : t("newSession.gateway");
  const destinationLabel = params.cloudProfileId
    ? t("newSession.cloudWorker", { profile: params.cloudProfileId })
    : params.execNode
      ? (activeNode?.displayName ?? params.execNode)
      : gatewayLabel;
  const label = params.showDestinations ? `${folderLabel} · ${destinationLabel}` : folderLabel;
  const effectiveFolder = folder || params.workspace;
  const recents = params.recents.filter(
    (recent) =>
      recent.kind !== "folder" ||
      !recent.execNode ||
      deviceNodes.some((node) => node.nodeId === recent.execNode),
  );
  const recentItems = recents.map((recent) => {
    const node =
      recent.kind === "folder" && recent.execNode
        ? deviceNodes.find((candidate) => candidate.nodeId === recent.execNode)
        : undefined;
    const recentLabel =
      params.showDestinations && node
        ? `${recent.displayName} · ${node.displayName}`
        : recent.displayName;
    return { ...recent, label: recentLabel, node };
  });
  const recentSuffixes = disambiguate(recentItems, (recent) => recent.label, [
    (recent) => (recent.kind === "folder" ? parentFolderDisplayName(recent.folder) : undefined),
    (recent) => (recent.kind === "folder" ? recent.folder : undefined),
    (recent) => recent.node?.modelIdentifier,
    (recent) => recent.node?.remoteIp,
    (recent) =>
      recent.kind === "folder"
        ? `${recent.folder}${recent.execNode ? ` · ${recent.execNode.slice(0, 8)}` : ""}`
        : recent.projectId,
  ]);
  const nodeSuffixes = disambiguate(deviceNodes, (node) => node.displayName, [
    (node) => node.modelIdentifier,
    (node) => node.remoteIp,
    (node) => node.nodeId.slice(0, 8),
  ]);
  const browseTarget: BrowserTarget = params.execNode
    ? { nodeId: params.execNode, label: activeNode?.displayName ?? params.execNode }
    : { nodeId: "", label: gatewayLabel };
  const nodeIcon = isPhoneFamily(activeNode?.deviceFamily)
    ? icons.monitorSmartphone
    : icons.monitor;
  const browseNeedsAdmin = !params.browseAvailable && !params.isAdmin;
  // Native disabled buttons suppress pointer/focus events in some browsers, so the
  // repair tooltip keeps only this limited-access state focusable and guards activation.
  const browseButton = html`<button
    type="button"
    class="session-menu__item"
    data-value="browse"
    aria-pressed="false"
    aria-disabled=${browseNeedsAdmin ? "true" : nothing}
    ?disabled=${params.submitting ||
    params.pendingCloud ||
    (!params.browseAvailable && !browseNeedsAdmin)}
    @click=${() => {
      if (params.browseAvailable && !params.submitting && !params.pendingCloud) {
        params.onBrowse(browseTarget);
      }
    }}
  >
    <span class="session-menu__check" aria-hidden="true"></span>
    <span class="session-menu__text">${t("newSession.browse")}</span>
    <span class="new-session-page__menu-chevron" aria-hidden="true">${icons.chevronRight}</span>
  </button>`;

  return html`
    <span class="new-session-page__select">
      <button
        id="new-session-place-trigger"
        type="button"
        class="new-session-page__trigger ${params.popoverHiding
          ? "new-session-page__trigger--hiding"
          : ""}"
        title=${t("newSession.where")}
        aria-label="${t("newSession.where")}: ${label}"
        data-worktree=${String(params.worktree)}
        data-project-id=${params.projectId || nothing}
        data-cloud-profile=${params.cloudProfileId || nothing}
        aria-haspopup="dialog"
        aria-expanded=${String(params.popoverOpen)}
        ?disabled=${params.submitting || params.pendingCloud}
        @click=${params.onGuardTransition}
      >
        <span class="new-session-page__target-icon" aria-hidden="true"
          >${params.cloudProfileId
            ? icons.server
            : params.execNode
              ? nodeIcon
              : selectedProject
                ? icons.gitBranch
                : icons.folder}</span
        >
        <span class="new-session-page__trigger-label">${label}</span>
        ${params.worktree
          ? html`<span class="new-session-page__target-icon" aria-hidden="true"
              >${icons.gitBranch}</span
            >`
          : nothing}
        <span class="new-session-page__trigger-chevron" aria-hidden="true"
          >${icons.chevronDown}</span
        >
      </button>
    </span>
    <wa-popover
      class="new-session-page__select new-session-page__place-popover"
      for="new-session-place-trigger"
      placement="bottom-start"
      without-arrow
      @wa-show=${params.onPopoverShow}
      @wa-hide=${params.onPopoverHide}
      @wa-after-hide=${params.onPopoverAfterHide}
    >
      ${params.browserTarget
        ? renderPlaceBrowser({
            listing: params.browserListing,
            target: params.browserTarget,
            loading: params.browserLoading,
            error: params.browserError,
            pathDraft: params.browserPathDraft,
            usablePath: params.usableBrowserPath,
            registerProjectPath: params.registerProjectPath,
            registeringProject: params.registeringProject,
            onPathDraftChange: params.onBrowserPathDraftChange,
            onNavigate: params.onBrowserNavigate,
            onBack: params.onBrowserBack,
            onRegisterProject: params.onRegisterProject,
            onClose: params.onClose,
            onApplyFolder: params.onApplyFolder,
          })
        : html`
            <div class="new-session-page__place-root">
              <div class="new-session-page__menu-title">${t("newSession.folder")}</div>
              ${params.workspace
                ? renderSessionMenuItem(
                    {
                      value: "workspace",
                      label: folderDisplayName(params.workspace),
                      checked:
                        !params.projectId &&
                        !params.execNode &&
                        effectiveFolder === params.workspace,
                      onSelect: () => params.onApplyFolder(params.workspace, ""),
                    },
                    params.submitting,
                  )
                : nothing}
              <div class="new-session-page__menu-title">${t("newSession.projects")}</div>
              <label class="new-session-page__project-search">
                <span class="sr-only">${t("newSession.projectSearchPlaceholder")}</span>
                <input
                  type="search"
                  placeholder=${t("newSession.projectSearchPlaceholder")}
                  .value=${params.projectQuery}
                  ?disabled=${params.submitting || params.pendingCloud || params.projectCloneBusy}
                  @input=${(event: Event) =>
                    params.onProjectQueryInput((event.target as HTMLInputElement).value)}
                  @keydown=${(event: KeyboardEvent) => {
                    if (event.key === "Enter" && cloneInput && params.projectAddAvailable) {
                      event.preventDefault();
                      params.onCloneProject(cloneInput);
                    }
                  }}
                />
              </label>
              ${localProjects.map((project) =>
                renderSessionMenuItem(
                  {
                    value: `project:${project.id}`,
                    label: project.displayName,
                    icon: icons.gitBranch,
                    checked: params.projectId === project.id,
                    title: project.repoRoot,
                    onSelect: () => params.onSelectProject(project.id),
                  },
                  params.submitting || params.projectCloneBusy,
                ),
              )}
              ${cloneInput && params.projectAddAvailable
                ? renderSessionMenuItem(
                    {
                      value: "project-clone-url",
                      label: cloneInput,
                      icon: icons.gitBranch,
                      sub: t("newSession.cloneProject"),
                      checked: false,
                      keepOpen: true,
                      onSelect: () => params.onCloneProject(cloneInput),
                    },
                    params.submitting || params.projectCloneBusy,
                  )
                : nothing}
              ${!cloneInput && projectQuery.length >= 2 && params.projectSearchAvailable
                ? html`
                    <div class="new-session-page__menu-title">
                      ${t("newSession.githubProjects")}
                    </div>
                    ${params.projectSearchCredential === "missing"
                      ? html`<div class="new-session-page__menu-note">
                          ${t("newSession.githubTokenHint")}
                        </div>`
                      : nothing}
                    ${params.projectSearchLoading
                      ? html`<div class="new-session-page__project-status" role="status">
                          ${t("common.loading")}
                        </div>`
                      : nothing}
                    ${params.projectSearchError
                      ? html`<div class="new-session-page__project-error" role="alert">
                          ${params.projectSearchError}
                        </div>`
                      : nothing}
                    ${params.remoteProjects.map((project) =>
                      renderSessionMenuItem(
                        {
                          value: `remote-project:${project.fullName}`,
                          label: project.fullName,
                          icon: icons.gitBranch,
                          sub: project.description ?? t("newSession.cloneProject"),
                          checked: false,
                          title: project.webUrl,
                          keepOpen: true,
                          onSelect: () => params.onCloneProject(project.cloneUrl),
                        },
                        params.submitting || params.projectCloneBusy || !params.projectAddAvailable,
                      ),
                    )}
                  `
                : nothing}
              ${params.projectCloneBusy
                ? html`<div class="new-session-page__project-status" role="status">
                    ${t("newSession.cloningProject")}
                  </div>`
                : nothing}
              ${params.projectCloneError
                ? html`<div class="new-session-page__project-error" role="alert">
                    ${params.projectCloneError}
                  </div>`
                : nothing}
              ${params.projects.length === 0 && params.canWrite && !params.isAdmin
                ? html`<div class="new-session-page__menu-note">
                    ${t("newSession.projectsAdminHint")}
                  </div>`
                : nothing}
              ${recents.length > 0
                ? html`
                    <div class="new-session-page__menu-title">${t("newSession.recentFolders")}</div>
                    ${recentItems.map((recent, index) => {
                      return renderSessionMenuItem(
                        {
                          value:
                            recent.kind === "project"
                              ? `recent-project:${recent.projectId}`
                              : `recent:${recent.execNode ?? ""}:${recent.folder}`,
                          label: recent.label,
                          icon: recent.kind === "project" ? icons.gitBranch : icons.folder,
                          sub: recentSuffixes[index],
                          checked:
                            recent.kind === "project"
                              ? params.projectId === recent.projectId
                              : !params.projectId &&
                                params.execNode === (recent.execNode ?? "") &&
                                folder === recent.folder,
                          title: recent.kind === "project" ? undefined : recent.folder,
                          onSelect: () =>
                            recent.kind === "project"
                              ? params.onSelectProject(recent.projectId)
                              : params.onApplyFolder(recent.folder, recent.execNode ?? ""),
                        },
                        params.submitting,
                      );
                    })}
                  `
                : nothing}
              ${browseNeedsAdmin
                ? html`<openclaw-tooltip .content=${t("newSession.browseRequiresAdmin")}>
                    ${browseButton}
                  </openclaw-tooltip>`
                : browseButton}
              ${params.showDestinations
                ? html`
                    <div class="new-session-page__menu-title">${t("newSession.thisGateway")}</div>
                    ${renderSessionMenuItem(
                      {
                        value: "gateway",
                        label: gatewayLabel,
                        icon: icons.monitor,
                        checked: !params.execNode && !params.cloudProfileId,
                        onSelect: () => params.onSelectExecNode(""),
                      },
                      params.submitting,
                    )}
                    ${deviceNodes.length > 0
                      ? html`
                          <div class="new-session-page__menu-title">
                            ${t("newSession.yourDevices")}
                          </div>
                          ${deviceNodes.map((node, index) =>
                            renderSessionMenuItem(
                              {
                                value: `node:${node.nodeId}`,
                                label: node.displayName,
                                icon: isPhoneFamily(node.deviceFamily)
                                  ? icons.monitorSmartphone
                                  : icons.monitor,
                                sub: nodeSuffixes[index],
                                facts: deviceFacts.get(node.nodeId),
                                checked: params.execNode === node.nodeId,
                                title: nodeTooltip(node),
                                onSelect: () => params.onSelectExecNode(node.nodeId),
                              },
                              params.submitting,
                            ),
                          )}
                        `
                      : nothing}
                    ${cloudProfiles.length > 0 || (params.cloudProfileId && !activeProfile)
                      ? html`
                          <div class="new-session-page__menu-title">${t("newSession.cloud")}</div>
                          ${renderCloudProfileMenuItems({
                            profiles: cloudProfiles,
                            selectedId: params.cloudProfileId,
                            submitting: params.submitting,
                            icon: icons.server,
                            disabled:
                              !params.worktreeAvailable || Boolean(params.cloudDisabledReason),
                            disabledReason: params.cloudDisabledReason,
                            onSelect: params.onSelectCloudProfile,
                          })}
                          ${params.cloudProfileId && !activeProfile
                            ? renderSessionMenuItem(
                                {
                                  value: `cloud:${params.cloudProfileId}`,
                                  label: t("newSession.cloudWorker", {
                                    profile: params.cloudProfileId,
                                  }),
                                  icon: icons.server,
                                  checked: true,
                                  disabled: true,
                                  title: t("newSession.catalogUnavailable"),
                                  onSelect: () => undefined,
                                },
                                params.submitting,
                              )
                            : nothing}
                          ${params.cloudProfileId && params.syncFolder
                            ? html`<div class="new-session-page__menu-note">
                                ${t("newSession.cloudSyncsFolder", {
                                  folder: folderDisplayName(params.syncFolder),
                                })}
                              </div>`
                            : nothing}
                        `
                      : nothing}
                  `
                : nothing}
              ${!params.execNode && params.worktreeVisible
                ? html`
                    <div class="session-menu__separator" role="separator"></div>
                    ${renderSessionMenuItem(
                      {
                        value: "worktree",
                        label: t("newSession.worktree"),
                        checked: params.worktree,
                        // Failed discovery blocks enabling Worktree, but an existing selection
                        // must stay actionable so the user can clear the submit-blocking state.
                        disabled:
                          Boolean(params.cloudProfileId) ||
                          (!params.worktreeAvailable && !params.worktree),
                        title: params.cloudProfileId
                          ? t("newSession.cloudRequiresWorktree")
                          : params.worktreeAvailable
                            ? t("chat.runControls.newSessionWorktree")
                            : (params.worktreeDisabledReason ??
                              t("newSession.worktreeUnavailable")),
                        onSelect: params.onToggleWorktree,
                        keepOpen: true,
                      },
                      params.submitting,
                    )}
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
                                params.onBaseRefInput(
                                  (event.target as HTMLInputElement).value.trim(),
                                )}
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
                      : nothing}
                  `
                : nothing}
              ${params.showDestinations
                ? nothing
                : html`<div class="new-session-page__menu-note">
                    ${t("newSession.runsOn", { place: gatewayLabel })}
                  </div>`}
              ${params.isAdmin
                ? renderConnectMachineMenuItem({
                    disabled: params.submitting || params.pendingCloud,
                    onSelect: params.onConnectMachine,
                  })
                : nothing}
            </div>
          `}
    </wa-popover>
  `;
}
