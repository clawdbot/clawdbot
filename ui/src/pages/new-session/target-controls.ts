import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { renderCloudProfileMenuItems, renderSessionMenuItem } from "./cloud-target.ts";
import type { DraftBranches, DraftCloudProfile, DraftNode } from "./discovery.ts";
import { folderDisplayName } from "./path.ts";

type DraftAgent = {
  id: string;
  name?: string;
  identity?: { name?: string };
};

function agentDisplayName(agent: DraftAgent): string {
  return agent.identity?.name ?? agent.name ?? agent.id;
}

export function renderAgentSelect(params: {
  agents: DraftAgent[];
  agentId: string;
  disabled: boolean;
  popoverOpen: boolean;
  popoverHiding: boolean;
  onGuardTransition: (event: MouseEvent) => void;
  onPopoverOpenChange: (open: boolean) => void;
  onPopoverHidingChange: (hiding: boolean) => void;
  onRestoreTrigger: () => void;
  onSelect: (agentId: string) => void;
}) {
  const selectedId = normalizeAgentId(params.agentId);
  const active = params.agents.find((agent) => normalizeAgentId(agent.id) === selectedId);
  const activeLabel = active ? agentDisplayName(active) : params.agentId;
  return html`
    <span class="new-session-page__select">
      <button
        id="new-session-agent-trigger"
        type="button"
        class="new-session-page__trigger ${params.popoverHiding
          ? "new-session-page__trigger--hiding"
          : ""}"
        title=${t("newSession.agent")}
        aria-label="${t("newSession.agent")}: ${activeLabel}"
        aria-haspopup="dialog"
        aria-expanded=${String(params.popoverOpen)}
        ?disabled=${params.disabled}
        @click=${params.onGuardTransition}
      >
        <span class="new-session-page__target-icon" aria-hidden="true">${icons.bot}</span>
        <span class="new-session-page__trigger-label">${activeLabel}</span>
        <span class="new-session-page__trigger-chevron" aria-hidden="true"
          >${icons.chevronDown}</span
        >
      </button>
    </span>
    <wa-popover
      class="new-session-page__select new-session-page__agent-popover"
      for="new-session-agent-trigger"
      placement="bottom-start"
      without-arrow
      @wa-show=${() => params.onPopoverOpenChange(true)}
      @wa-hide=${() => {
        params.onPopoverOpenChange(false);
        params.onPopoverHidingChange(true);
      }}
      @wa-after-hide=${() => {
        params.onPopoverHidingChange(false);
        params.onRestoreTrigger();
      }}
    >
      <div class="new-session-page__menu-title">${t("newSession.agent")}</div>
      ${params.agents.map((option) =>
        renderSessionMenuItem(
          {
            value: normalizeAgentId(option.id),
            label: agentDisplayName(option),
            checked: normalizeAgentId(option.id) === selectedId,
            onSelect: () => params.onSelect(normalizeAgentId(option.id)),
          },
          params.disabled,
        ),
      )}
    </wa-popover>
  `;
}

export function renderWhereSelect(params: {
  execNodes: DraftNode[];
  cloudProfiles: DraftCloudProfile[];
  cloudProfileId: string;
  execNode: string;
  syncFolder: string;
  worktree: boolean;
  worktreeAvailable: boolean;
  customFolder: boolean;
  branches: DraftBranches | null;
  branchesLoading: boolean;
  baseRef: string;
  worktreeName: string;
  submitting: boolean;
  pendingCloud: boolean;
  showTargets: boolean;
  popoverOpen: boolean;
  popoverHiding: boolean;
  onGuardTransition: (event: MouseEvent) => void;
  onPopoverOpenChange: (open: boolean) => void;
  onPopoverHidingChange: (hiding: boolean) => void;
  onRestoreTrigger: () => void;
  onSelectExecNode: (nodeId: string) => void;
  onSelectCloudProfile: (profileId: string) => void;
  onToggleWorktree: () => void;
  onBaseRefInput: (baseRef: string) => void;
  onWorktreeNameInput: (name: string) => void;
}) {
  const activeNode = params.execNodes.find((node) => node.nodeId === params.execNode);
  const activeProfile = params.cloudProfiles.find(
    (profile) => profile.id === params.cloudProfileId,
  );
  const whereLabel = params.cloudProfileId
    ? t("newSession.cloudWorker", { profile: params.cloudProfileId })
    : params.execNode
      ? (activeNode?.displayName ?? params.execNode)
      : t("newSession.gateway");
  return html`
    <span class="new-session-page__select">
      <button
        id="new-session-where-trigger"
        type="button"
        class="new-session-page__trigger ${params.popoverHiding
          ? "new-session-page__trigger--hiding"
          : ""}"
        title=${t("newSession.where")}
        aria-label="${t("newSession.where")}: ${whereLabel}"
        data-worktree=${String(params.worktree)}
        data-cloud-profile=${params.cloudProfileId || nothing}
        aria-haspopup="dialog"
        aria-expanded=${String(params.popoverOpen)}
        ?disabled=${params.submitting || params.pendingCloud}
        @click=${params.onGuardTransition}
      >
        <span class="new-session-page__target-icon" aria-hidden="true"
          >${params.cloudProfileId ? icons.server : icons.monitor}</span
        >
        <span class="new-session-page__trigger-label">${whereLabel}</span>
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
      class="new-session-page__select new-session-page__where-popover"
      for="new-session-where-trigger"
      placement="bottom-start"
      without-arrow
      @wa-show=${() => params.onPopoverOpenChange(true)}
      @wa-hide=${() => {
        params.onPopoverOpenChange(false);
        params.onPopoverHidingChange(true);
      }}
      @wa-after-hide=${() => {
        params.onPopoverHidingChange(false);
        params.onRestoreTrigger();
      }}
    >
      ${params.showTargets
        ? html`
            <div class="new-session-page__menu-title">${t("newSession.where")}</div>
            ${renderSessionMenuItem(
              {
                value: "gateway",
                label: t("newSession.gateway"),
                checked: !params.execNode && !params.cloudProfileId,
                onSelect: () => params.onSelectExecNode(""),
              },
              params.submitting,
            )}
            ${params.execNodes.map((node) =>
              renderSessionMenuItem(
                {
                  value: `node:${node.nodeId}`,
                  label: node.displayName,
                  checked: params.execNode === node.nodeId,
                  onSelect: () => params.onSelectExecNode(node.nodeId),
                },
                params.submitting,
              ),
            )}
            ${renderCloudProfileMenuItems({
              profiles: params.cloudProfiles,
              selectedId: params.cloudProfileId,
              submitting: params.submitting,
              disabled: !params.worktreeAvailable,
              onSelect: params.onSelectCloudProfile,
            })}
            ${params.cloudProfileId && !activeProfile
              ? renderSessionMenuItem(
                  {
                    value: `cloud:${params.cloudProfileId}`,
                    label: t("newSession.cloudWorker", { profile: params.cloudProfileId }),
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
      ${!params.execNode
        ? html`
            ${params.showTargets
              ? html`<div class="session-menu__separator" role="separator"></div>`
              : nothing}
            ${renderSessionMenuItem(
              {
                value: "worktree",
                label: t("newSession.worktree"),
                checked: params.worktree,
                disabled:
                  Boolean(params.cloudProfileId) ||
                  !params.worktreeAvailable ||
                  params.customFolder,
                title: params.cloudProfileId
                  ? t("newSession.cloudRequiresWorktree")
                  : params.worktreeAvailable
                    ? t("chat.runControls.newSessionWorktree")
                    : t("newSession.worktreeUnavailable"),
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
                        params.onWorktreeNameInput((event.target as HTMLInputElement).value.trim())}
                    />
                  </label>
                `
              : nothing}
          `
        : nothing}
    </wa-popover>
  `;
}

export function renderFolderSelect(params: {
  browseAvailable: boolean;
  folder: string;
  execNode: string;
  workspace: string;
  browserOpen: boolean;
  popoverHiding: boolean;
  submitting: boolean;
  pendingCloud: boolean;
  browser: unknown;
  onGuardTransition: (event: MouseEvent) => void;
  onShow: () => void;
  onHide: () => void;
  onAfterHide: () => void;
}) {
  const folder = params.folder.trim();
  // An empty folder on a node session means that node's default directory.
  const label = folder
    ? folderDisplayName(folder)
    : params.execNode
      ? t("newSession.folderPlaceholder")
      : folderDisplayName(params.workspace) || t("newSession.folderPlaceholder");
  return html`
    <span class="new-session-page__select">
      <button
        id="new-session-folder-trigger"
        type="button"
        class="new-session-page__trigger ${params.browseAvailable
          ? ""
          : "new-session-page__trigger--disabled"} ${params.popoverHiding
          ? "new-session-page__trigger--hiding"
          : ""}"
        title=${params.browseAvailable
          ? t("newSession.browse")
          : t("newSession.browseRequiresAdmin")}
        aria-label="${t("newSession.folder")}: ${label}"
        aria-haspopup="dialog"
        aria-expanded=${String(params.browserOpen)}
        ?disabled=${params.submitting || params.pendingCloud || !params.browseAvailable}
        @click=${params.onGuardTransition}
      >
        <span class="new-session-page__target-icon" aria-hidden="true">${icons.folder}</span>
        <span class="new-session-page__trigger-label">${label}</span>
        <span class="new-session-page__trigger-chevron" aria-hidden="true"
          >${icons.chevronDown}</span
        >
      </button>
    </span>
    <wa-popover
      class="new-session-page__select new-session-page__select--folder"
      for="new-session-folder-trigger"
      placement="bottom-start"
      without-arrow
      @wa-show=${params.onShow}
      @wa-hide=${params.onHide}
      @wa-after-hide=${params.onAfterHide}
    >
      <div class="new-session-page__browser-menu">${params.browser}</div>
    </wa-popover>
  `;
}
