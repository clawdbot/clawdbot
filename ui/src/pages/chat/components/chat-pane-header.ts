import { html, nothing, type TemplateResult } from "lit";
import type { GatewaySessionRow, SessionBranch } from "../../../api/types.ts";
import { beginNativeWindowDrag } from "../../../app/native-window-drag.ts";
import {
  COMMAND_PALETTE_OPEN_EVENT,
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  type ShellNavDrawerToggleDetail,
} from "../../../components/command-palette-contract.ts";
import { icons } from "../../../components/icons.ts";
import { renderSessionOwnerChip } from "../../../components/session-owner-chip.ts";
import { isCloudWorkerPlacementState } from "../../../components/session-row-badges.ts";
import "../../../components/tooltip.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";

export type ChatPaneHeaderAction = "reveal" | "copy-path" | "copy-branch";

type ChatPaneHeaderProps = {
  paneId: string;
  narrow: boolean;
  mergedChrome: boolean;
  title: string;
  session: GatewaySessionRow | undefined;
  showOwnerChip?: boolean;
  catalog: boolean;
  editing: boolean;
  renameValue: string;
  workspaceRoot: string | null;
  workspaceLabel: string | null;
  branch: string | null;
  branches: SessionBranch[];
  branchSwitchDisabledReason: string | null;
  platform: string | null;
  canReveal: boolean;
  copiedAction: ChatPaneHeaderAction | null;
  canRename: boolean;
  terminalAction: TemplateResult | typeof nothing;
  discussionAction: TemplateResult | typeof nothing;
  diffAction: TemplateResult | typeof nothing;
  backgroundTasksAction: TemplateResult | typeof nothing;
  workspaceAction: TemplateResult | typeof nothing;
  presence?: TemplateResult | typeof nothing;
  faceControl?: TemplateResult | typeof nothing;
  sharingControl?: TemplateResult | typeof nothing;
  boardDockAction?: TemplateResult | typeof nothing;
  onBeginRename: () => void;
  onRenameInput: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onMenuOpenChange: (open: boolean) => void;
  onMenuAction: (action: ChatPaneHeaderAction) => void;
  onBranchSelect: (leafEntryId: string) => void;
  onOpenSplitView?: () => void;
  onSplitDown?: (paneId: string) => void;
  onSplitRight?: (paneId: string) => void;
  onClosePane?: (paneId: string) => void;
};

function revealLabel(platform: string | null): string {
  if (platform === "darwin") {
    return t("chat.sessionHeader.revealFinder");
  }
  if (platform === "win32") {
    return t("chat.sessionHeader.revealFileExplorer");
  }
  return t("chat.sessionHeader.revealFileManager");
}

function pathBasename(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

function branchRelativeTime(updatedAt: string | undefined): string {
  const timestamp = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return Number.isFinite(timestamp) ? formatRelativeTimestamp(timestamp, { fallback: "" }) : "";
}

export function resolveChatPaneWorkspace(params: {
  session: GatewaySessionRow | undefined;
  agentWorkspace?: string;
  worktreePath?: string | null;
}): { root: string | null; label: string | null } {
  const row = params.session;
  if (!row) {
    return { root: null, label: null };
  }
  // Exec-node sessions live on another machine: gateway-local facts would
  // hand the user a path for the wrong host, so only execCwd may name them.
  // Cloud-worker sessions keep their gateway-local checkout (workers sync
  // against it), so local facts stay correct there.
  // Mirror the gateway's loadSessionFileRoot order (spawned workspace before
  // spawned cwd) so copy-path and the chip tooltip name the same directory
  // sessions.files.reveal opens.
  const root = row.execNode
    ? row.execCwd?.trim() || null
    : row.spawnedWorkspaceDir?.trim() ||
      row.spawnedCwd?.trim() ||
      params.worktreePath?.trim() ||
      (!row.worktree ? params.agentWorkspace?.trim() : "") ||
      null;
  const label = row.worktree?.repoRoot
    ? pathBasename(row.worktree.repoRoot)
    : root
      ? pathBasename(root)
      : null;
  return { root, label };
}

export function canRevealSessionWorkspace(params: {
  session: GatewaySessionRow | undefined;
  workspaceRoot: string | null;
  methodAdvertised: boolean;
  hasAdminAccess: boolean;
}): boolean {
  return Boolean(
    params.workspaceRoot &&
    params.methodAdvertised &&
    params.hasAdminAccess &&
    !params.session?.execNode &&
    !isCloudWorkerPlacementState(params.session?.placement?.state),
  );
}

export function renderChatPaneHeader(props: ChatPaneHeaderProps) {
  const placementState = props.session?.placement?.state;
  const cloud = isCloudWorkerPlacementState(placementState);
  const cloudLabel = cloud ? t("sessionsView.cloudWorkerPlacement", { state: placementState }) : "";
  const copyPathLabel =
    props.copiedAction === "copy-path"
      ? t("chat.sessionHeader.copied")
      : t("chat.sessionHeader.copyPath");
  const copyBranchLabel =
    props.copiedAction === "copy-branch"
      ? t("chat.sessionHeader.copied")
      : t("chat.sessionHeader.copyBranch");
  const copied = props.copiedAction === "copy-path" || props.copiedAction === "copy-branch";

  return html`
    <div class="chat-pane__header" @mousedown=${beginNativeWindowDrag}>
      ${props.mergedChrome
        ? html`<openclaw-tooltip .content=${t("nav.expand")}>
            <button
              class="btn btn--ghost btn--icon chat-icon-btn chat-pane__nav-toggle"
              type="button"
              aria-label=${t("nav.expand")}
              @click=${(event: MouseEvent) => {
                window.dispatchEvent(
                  new CustomEvent<ShellNavDrawerToggleDetail>(SHELL_NAV_DRAWER_TOGGLE_EVENT, {
                    detail: { trigger: event.currentTarget as HTMLElement },
                  }),
                );
              }}
            >
              ${icons.menu}
            </button>
          </openclaw-tooltip>`
        : nothing}
      ${cloud
        ? html`<span
            class="chat-pane__cloud"
            role="img"
            aria-label=${cloudLabel}
            title=${cloudLabel}
            >${icons.globe}</span
          >`
        : nothing}
      ${props.session?.incognito
        ? html`<span
            class="chat-pane__incognito"
            role="img"
            aria-label=${t("chat.sessionHeader.incognito")}
            title=${t("chat.sessionHeader.incognito")}
            >${icons.lock}</span
          >`
        : nothing}
      ${props.editing
        ? html`<input
            class="chat-pane__session-title-input"
            .value=${props.renameValue}
            aria-label=${t("chat.sessionHeader.renameInputAria")}
            placeholder=${t("chat.sessionHeader.renameInputPlaceholder")}
            @input=${(event: InputEvent) =>
              props.onRenameInput((event.currentTarget as HTMLInputElement).value)}
            @keydown=${(event: KeyboardEvent) => {
              if (event.key === "Enter") {
                event.preventDefault();
                props.onCommitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                props.onCancelRename();
              }
            }}
            @blur=${props.onCommitRename}
          />`
        : props.catalog || !props.session || !props.canRename
          ? html`<span class="chat-pane__session-title" title=${props.title}>${props.title}</span>`
          : html`<button
              class="chat-pane__session-title chat-pane__session-title-button"
              type="button"
              title=${t("chat.sessionHeader.renameTooltip")}
              aria-label=${t("chat.sessionHeader.renameAria", { title: props.title })}
              @click=${props.onBeginRename}
            >
              ${props.title}
            </button>`}
      ${renderSessionOwnerChip(
        props.showOwnerChip ? props.session?.createdActor : undefined,
        "header",
      )}
      ${!props.catalog && props.workspaceLabel
        ? html`
            <wa-dropdown
              class="chat-pane__workspace-menu"
              placement="bottom-start"
              @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
                const value = event.detail.item.value;
                if (value === "reveal" || value === "copy-path" || value === "copy-branch") {
                  props.onMenuAction(value);
                }
              }}
              @wa-show=${() => props.onMenuOpenChange(true)}
              @wa-hide=${() => props.onMenuOpenChange(false)}
            >
              <button
                slot="trigger"
                class="chat-pane__workspace-chip"
                type="button"
                title=${props.workspaceRoot ?? props.workspaceLabel}
                aria-label=${t("chat.sessionHeader.workspaceAria", {
                  workspace: props.workspaceLabel,
                })}
              >
                ${copied ? icons.check : icons.folder}<span
                  >${copied ? t("chat.sessionHeader.copied") : props.workspaceLabel}</span
                >
              </button>
              ${props.canReveal && props.workspaceRoot
                ? html`<wa-dropdown-item value="reveal"
                    >${revealLabel(props.platform)}</wa-dropdown-item
                  >`
                : nothing}
              ${props.workspaceRoot
                ? html`<wa-dropdown-item value="copy-path">${copyPathLabel}</wa-dropdown-item>`
                : nothing}
              ${props.branch
                ? html`<wa-dropdown-item value="copy-branch">${copyBranchLabel}</wa-dropdown-item>`
                : nothing}
            </wa-dropdown>
          `
        : nothing}
      ${props.presence ?? nothing} ${props.faceControl ?? nothing}
      ${props.sharingControl ?? nothing}
      ${!props.catalog && props.branches.length > 1
        ? html`
            <wa-dropdown
              class="chat-pane__branches-menu"
              placement="bottom-end"
              @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
                const leafEntryId = event.detail.item.value;
                const branch = props.branches.find(
                  (candidate) => candidate.leafEntryId === leafEntryId,
                );
                if (leafEntryId && branch && !branch.active && !props.branchSwitchDisabledReason) {
                  props.onBranchSelect(leafEntryId);
                }
              }}
            >
              <openclaw-tooltip
                slot="trigger"
                .content=${props.branchSwitchDisabledReason ?? t("chat.sessionHeader.branches")}
              >
                <button
                  class="btn btn--ghost btn--icon chat-icon-btn chat-pane__branches-trigger"
                  type="button"
                  ?disabled=${Boolean(props.branchSwitchDisabledReason)}
                  aria-label=${t("chat.sessionHeader.branches")}
                >
                  ${icons.gitBranch}
                </button>
              </openclaw-tooltip>
              ${props.branches.map((branch) => {
                const relativeTime = branchRelativeTime(branch.updatedAt);
                return html`
                  <wa-dropdown-item
                    class="chat-pane__branch-item"
                    value=${branch.leafEntryId}
                    ?disabled=${branch.active || Boolean(props.branchSwitchDisabledReason)}
                    data-active=${branch.active ? "true" : "false"}
                  >
                    <span class="chat-pane__branch-copy">
                      <span class="chat-pane__branch-headline"
                        >${branch.headline || t("chat.sessionHeader.untitledBranch")}</span
                      >
                      <span class="chat-pane__branch-meta"
                        >${t(
                          branch.messageCount === 1
                            ? "chat.sessionHeader.oneMessage"
                            : "chat.sessionHeader.messages",
                          { count: String(branch.messageCount) },
                        )}${relativeTime ? ` · ${relativeTime}` : ""}</span
                      >
                    </span>
                    ${branch.active
                      ? html`<span
                          class="chat-pane__branch-active"
                          aria-label=${t("chat.sessionHeader.activeBranch")}
                          >${icons.check}</span
                        >`
                      : nothing}
                  </wa-dropdown-item>
                `;
              })}
            </wa-dropdown>
          `
        : nothing}
      <div class="chat-pane__actions">
        ${props.boardDockAction ?? nothing} ${props.terminalAction} ${props.discussionAction}
        ${props.catalog
          ? nothing
          : html`${props.diffAction} ${props.backgroundTasksAction} ${props.workspaceAction}`}
        ${props.onOpenSplitView
          ? html`<openclaw-tooltip .content=${t("chat.splitView.open")}>
              <button
                class="btn btn--ghost btn--icon chat-icon-btn chat-open-split-view"
                type="button"
                aria-label=${t("chat.splitView.open")}
                @click=${props.onOpenSplitView}
              >
                ${icons.columns2}
              </button>
            </openclaw-tooltip>`
          : nothing}
        ${!props.narrow && props.onSplitDown
          ? html`<openclaw-tooltip .content=${t("chat.splitView.splitDown")}>
              <button
                class="btn btn--ghost btn--icon chat-icon-btn"
                type="button"
                aria-label=${t("chat.splitView.splitDown")}
                @click=${() => props.onSplitDown?.(props.paneId)}
              >
                ${icons.panelBottomOpen}
              </button>
            </openclaw-tooltip>`
          : nothing}
        ${!props.narrow && props.onSplitRight
          ? html`<openclaw-tooltip .content=${t("chat.splitView.splitRight")}>
              <button
                class="btn btn--ghost btn--icon chat-icon-btn"
                type="button"
                aria-label=${t("chat.splitView.splitRight")}
                @click=${() => props.onSplitRight?.(props.paneId)}
              >
                ${icons.panelRightOpen}
              </button>
            </openclaw-tooltip>`
          : nothing}
        ${props.onClosePane
          ? html`<openclaw-tooltip .content=${t("chat.splitView.closePane")}>
              <button
                class="btn btn--ghost btn--icon chat-icon-btn"
                type="button"
                aria-label=${t("chat.splitView.closePane")}
                @click=${() => props.onClosePane?.(props.paneId)}
              >
                ${icons.x}
              </button>
            </openclaw-tooltip>`
          : nothing}
        ${props.mergedChrome
          ? html`<openclaw-tooltip .content=${t("chat.openCommandPalette")}>
              <button
                class="btn btn--ghost btn--icon chat-icon-btn chat-pane__palette-open"
                type="button"
                aria-label=${t("chat.openCommandPalette")}
                @click=${() => window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT))}
              >
                ${icons.search}
              </button>
            </openclaw-tooltip>`
          : nothing}
      </div>
    </div>
  `;
}
