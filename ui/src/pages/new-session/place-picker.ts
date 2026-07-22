import { html, nothing } from "lit";
import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { renderCloudProfileMenuItems, renderSessionMenuItem } from "./cloud-target.ts";
import type { BrowserTarget, DraftBranches, DraftCloudProfile, DraftNode } from "./discovery.ts";
import { folderDisplayName } from "./path.ts";
import { disambiguate, isPhoneFamily, nodeTooltip } from "./place-labels.ts";
import { recentPlaces, type RecentPlaceSource } from "./recent-places.ts";

function parentFolderDisplayName(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/u, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separator < 0) {
    return undefined;
  }
  const parent = separator === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, separator);
  return folderDisplayName(parent) || undefined;
}

function renderBrowseView(params: {
  listing: FsListDirResult | null;
  target: BrowserTarget;
  loading: boolean;
  error: string | null;
  pathDraft: string;
  usablePath: string | null;
  onPathDraftChange: (value: string) => void;
  onNavigate: (path: string | undefined) => void;
  onBack: () => void;
  onClose: () => void;
  onApplyFolder: (path: string, nodeId: string) => void;
}) {
  const entries = params.listing?.entries ?? [];
  return html`
    <div
      class="new-session-page__browser"
      @keydown=${(event: KeyboardEvent) => {
        if (event.key !== "Escape") {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        params.onBack();
      }}
    >
      <div class="new-session-page__browser-head">
        <button
          type="button"
          class="new-session-page__browser-nav"
          title=${t("newSession.browserUp")}
          aria-label=${t("newSession.browserUp")}
          @click=${() => {
            if (params.listing?.parent) {
              params.onNavigate(params.listing.parent);
            } else {
              params.onBack();
            }
          }}
        >
          ${icons.arrowLeft}
        </button>
        <input
          class="new-session-page__browser-path"
          type="text"
          aria-label=${t("newSession.folder")}
          placeholder=${params.target.label}
          .value=${params.pathDraft}
          @input=${(event: Event) => {
            params.onPathDraftChange((event.target as HTMLInputElement).value);
          }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Enter") {
              event.preventDefault();
              params.onNavigate(params.pathDraft.trim() || undefined);
            }
          }}
        />
        ${params.loading
          ? html`<span class="new-session-page__browser-loading">${t("common.loading")}</span>`
          : nothing}
        <button
          type="button"
          class="new-session-page__browser-nav"
          title=${t("common.close")}
          aria-label=${t("common.close")}
          @click=${params.onClose}
        >
          ${icons.x}
        </button>
      </div>
      ${params.error ? html`<div class="new-session-page__error">${params.error}</div>` : nothing}
      <div class="new-session-page__browser-list" role="group" aria-label=${t("newSession.folder")}>
        ${params.listing && entries.length === 0 && !params.loading
          ? html`<div class="new-session-page__browser-empty">${t("newSession.browserEmpty")}</div>`
          : nothing}
        ${entries.map(
          (entry) => html`
            <button
              type="button"
              class="new-session-page__browser-entry ${entry.hidden
                ? "new-session-page__browser-entry--hidden"
                : ""}"
              title=${entry.hidden ? t("newSession.hiddenFolder") : nothing}
              @click=${() => params.onNavigate(entry.path)}
            >
              <span class="new-session-page__target-icon" aria-hidden="true">${icons.folder}</span>
              <span>${entry.name}</span>
            </button>
          `,
        )}
      </div>
      <div class="new-session-page__browser-actions">
        <button
          type="button"
          class="new-session-page__browser-use"
          ?disabled=${params.usablePath === null}
          @click=${() => {
            if (params.usablePath !== null) {
              params.onApplyFolder(params.usablePath, params.target.nodeId);
              params.onClose();
            }
          }}
        >
          ${t("newSession.browserUse")}
        </button>
      </div>
    </div>
  `;
}

export function renderPlaceSelect(params: {
  browseAvailable: boolean;
  folder: string;
  workspace: string;
  sessions: readonly RecentPlaceSource[];
  execNodes: DraftNode[];
  gatewayName: string;
  cloudProfiles: DraftCloudProfile[];
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
  onGuardTransition: (event: MouseEvent) => void;
  onPopoverShow: () => void;
  onPopoverHide: () => void;
  onPopoverAfterHide: () => void;
  onSelectExecNode: (nodeId: string) => void;
  onSelectCloudProfile: (profileId: string) => void;
  onApplyFolder: (folder: string, execNode: string) => void;
  onBrowse: (target: BrowserTarget) => void;
  onBrowserPathDraftChange: (value: string) => void;
  onBrowserNavigate: (path: string | undefined) => void;
  onBrowserBack: () => void;
  onClose: () => void;
  onToggleWorktree: () => void;
  onBaseRefInput: (baseRef: string) => void;
  onWorktreeNameInput: (name: string) => void;
}) {
  const folder = params.folder.trim();
  const folderLabel = folder
    ? folderDisplayName(folder)
    : params.execNode
      ? t("newSession.folderPlaceholder")
      : folderDisplayName(params.workspace) || t("newSession.folderPlaceholder");
  const activeNode = params.execNodes.find((node) => node.nodeId === params.execNode);
  const activeProfile = params.cloudProfiles.find(
    (profile) => profile.id === params.cloudProfileId,
  );
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
  const recents = params.browseAvailable
    ? recentPlaces(params.sessions, { workspace: params.workspace, execNodes: params.execNodes })
    : [];
  const recentItems = recents.map((recent) => {
    const node = params.execNodes.find((candidate) => candidate.nodeId === recent.execNode);
    const recentLabel =
      params.showDestinations && node
        ? `${folderDisplayName(recent.folder)} · ${node.displayName}`
        : folderDisplayName(recent.folder);
    return { ...recent, label: recentLabel, node };
  });
  const recentSuffixes = disambiguate(recentItems, (recent) => recent.label, [
    (recent) => parentFolderDisplayName(recent.folder),
    (recent) => recent.folder,
    (recent) => recent.node?.modelIdentifier,
    (recent) => recent.node?.remoteIp,
    (recent) => `${recent.folder}${recent.execNode ? ` · ${recent.execNode.slice(0, 8)}` : ""}`,
  ]);
  const nodeSuffixes = disambiguate(params.execNodes, (node) => node.displayName, [
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
        data-cloud-profile=${params.cloudProfileId || nothing}
        aria-haspopup="dialog"
        aria-expanded=${String(params.popoverOpen)}
        ?disabled=${params.submitting || params.pendingCloud}
        @click=${params.onGuardTransition}
      >
        <span class="new-session-page__target-icon" aria-hidden="true"
          >${params.cloudProfileId ? icons.server : params.execNode ? nodeIcon : icons.folder}</span
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
        ? renderBrowseView({
            listing: params.browserListing,
            target: params.browserTarget,
            loading: params.browserLoading,
            error: params.browserError,
            pathDraft: params.browserPathDraft,
            usablePath: params.usableBrowserPath,
            onPathDraftChange: params.onBrowserPathDraftChange,
            onNavigate: params.onBrowserNavigate,
            onBack: params.onBrowserBack,
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
                      checked: !params.execNode && effectiveFolder === params.workspace,
                      onSelect: () => params.onApplyFolder(params.workspace, ""),
                    },
                    params.submitting,
                  )
                : nothing}
              ${recents.length > 0
                ? html`
                    <div class="new-session-page__menu-title">${t("newSession.recentFolders")}</div>
                    ${recentItems.map((recent, index) => {
                      return renderSessionMenuItem(
                        {
                          value: `recent:${recent.execNode}:${recent.folder}`,
                          label: recent.label,
                          sub: recentSuffixes[index],
                          checked: params.execNode === recent.execNode && folder === recent.folder,
                          title: recent.folder,
                          onSelect: () => params.onApplyFolder(recent.folder, recent.execNode),
                        },
                        params.submitting,
                      );
                    })}
                  `
                : nothing}
              <button
                type="button"
                class="session-menu__item"
                data-value="browse"
                aria-pressed="false"
                title=${params.browseAvailable ? nothing : t("newSession.browseRequiresAdmin")}
                ?disabled=${params.submitting || params.pendingCloud || !params.browseAvailable}
                @click=${() => params.onBrowse(browseTarget)}
              >
                <span class="session-menu__check" aria-hidden="true"></span>
                <span class="session-menu__text">${t("newSession.browse")}</span>
                <span class="new-session-page__menu-chevron" aria-hidden="true"
                  >${icons.chevronRight}</span
                >
              </button>

              ${params.showDestinations
                ? html`
                    <div class="new-session-page__menu-title">${t("newSession.places")}</div>
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
                    ${params.execNodes.map((node, index) =>
                      renderSessionMenuItem(
                        {
                          value: `node:${node.nodeId}`,
                          label: node.displayName,
                          icon: isPhoneFamily(node.deviceFamily)
                            ? icons.monitorSmartphone
                            : icons.monitor,
                          sub: nodeSuffixes[index],
                          checked: params.execNode === node.nodeId,
                          title: nodeTooltip(node),
                          onSelect: () => params.onSelectExecNode(node.nodeId),
                        },
                        params.submitting,
                      ),
                    )}
                    ${renderCloudProfileMenuItems({
                      profiles: params.cloudProfiles,
                      selectedId: params.cloudProfileId,
                      submitting: params.submitting,
                      icon: icons.server,
                      disabled: !params.worktreeAvailable || Boolean(params.cloudDisabledReason),
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
              ${!params.execNode && params.worktreeVisible
                ? html`
                    <div class="session-menu__separator" role="separator"></div>
                    ${renderSessionMenuItem(
                      {
                        value: "worktree",
                        label: t("newSession.worktree"),
                        checked: params.worktree,
                        disabled: Boolean(params.cloudProfileId) || !params.worktreeAvailable,
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
            </div>
          `}
    </wa-popover>
  `;
}
