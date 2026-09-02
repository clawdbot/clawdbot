import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { GatewaySessionRow, SessionBranch } from "../../../api/types.ts";
import type {
  NativeGatewaysCapability,
  NativeGatewaysSnapshot,
  NativeGateway,
} from "../../../app/native-gateways.runtime.ts";
import { isNativeWebChromeHost } from "../../../app/native-web-chrome.ts";
import { beginNativeWindowDrag } from "../../../app/native-window-drag.ts";
import {
  COMMAND_PALETTE_OPEN_EVENT,
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  type ShellNavDrawerToggleDetail,
} from "../../../components/command-palette-contract.ts";
import { icons } from "../../../components/icons.ts";
import {
  personActivityLink,
  renderStandalonePersonLink,
  type PersonActivityRouting,
} from "../../../components/person-activity-link.ts";
import { renderSessionColorDot } from "../../../components/session-color.ts";
import { renderSessionOwnerChip } from "../../../components/session-owner-chip.ts";
import { isCloudWorkerPlacementState } from "../../../components/session-row-badges.ts";
import { syncDropdownItemRadio } from "../../../components/web-awesome.ts";
import "../../../components/tooltip.ts";
import "../../../components/workspace-icon.ts";
import { t } from "../../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiSessionNavigationParentKey,
} from "../../../lib/sessions/session-key.ts";

export type ChatPaneHeaderAction = "reveal" | "copy-path" | "copy-branch";

type ChatPaneParentSession = {
  key: string;
  title: string;
};

type ChatPaneHeaderProps = {
  paneId: string;
  narrow: boolean;
  mergedChrome: boolean;
  navDrawerOpen?: boolean;
  title: string;
  session: GatewaySessionRow | undefined;
  showOwnerChip?: boolean;
  ownerViewing?: boolean;
  personActivity?: PersonActivityRouting;
  catalog: boolean;
  catalogColor?: string;
  editing: boolean;
  renameValue: string;
  workspaceRoot: string | null;
  workspaceLabel: string | null;
  /** Gateway-resolved project icon for the chip; absent keeps the folder glyph. */
  workspaceIcon: { routeUrl: string; authTokens: readonly string[]; authReady: boolean } | null;
  parentSession: ChatPaneParentSession | null;
  branch: string | null;
  branches: SessionBranch[];
  branchSwitchDisabledReason: string | null;
  platform: string | null;
  canReveal: boolean;
  copiedAction: ChatPaneHeaderAction | null;
  renameDisabledReason?: string;
  panelActions: TemplateResult | typeof nothing;
  discussionAction: TemplateResult | typeof nothing;
  diffAction: TemplateResult | typeof nothing;
  backgroundTasksAction: TemplateResult | typeof nothing;
  sessionRailAction: TemplateResult | typeof nothing;
  workspaceAction: TemplateResult | typeof nothing;
  presence?: TemplateResult | typeof nothing;
  faceControl?: TemplateResult | typeof nothing;
  sharingControl?: TemplateResult | typeof nothing;
  placementControl?: TemplateResult | typeof nothing;
  sessionMenuAction: TemplateResult | typeof nothing;
  nativeGateways?: NativeGatewaysCapability | null;
  gatewaysSnapshot?: NativeGatewaysSnapshot | null;
  onboarding?: boolean;
  onBeginRename: () => void;
  onRenameInput: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onMenuOpenChange: (open: boolean) => void;
  onMenuAction: (action: ChatPaneHeaderAction) => void;
  onOpenParentSession: (sessionKey: string) => void;
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

function branchRelativeTime(updatedAt: string | undefined): string {
  const timestamp = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return Number.isFinite(timestamp) ? formatRelativeTimestamp(timestamp, { fallback: "" }) : "";
}

export function resolveChatPaneParentSession(
  session: GatewaySessionRow | undefined,
  sessions: readonly GatewaySessionRow[],
): ChatPaneParentSession | null {
  const parentKey = resolveUiSessionNavigationParentKey(session);
  if (!parentKey || (session && areUiSessionKeysEquivalent(parentKey, session.key))) {
    return null;
  }
  const parent = sessions.find((row) => areUiSessionKeysEquivalent(row.key, parentKey));
  return parent ? { key: parent.key, title: resolveSessionDisplayName(parent.key, parent) } : null;
}

/**
 * Header identity trail: which project, then which session inside it. Segments
 * and separators are rendered from one list so a further segment — the parent
 * session of a nested thread, yielding project / parent / child — slots in
 * without moving the project chip or the title.
 */
function renderIdentityCrumbs(
  props: ChatPaneHeaderProps,
  copied: boolean,
  copyPathLabel: string,
  copyBranchLabel: string,
) {
  const projectCrumb = renderProjectCrumb(props, copied, copyPathLabel, copyBranchLabel);
  const parentCrumb = renderParentSessionCrumb(props);
  return html`
    <div class="chat-pane__crumbs">
      ${projectCrumb ? html`<div class="chat-pane__project-row">${projectCrumb}</div>` : nothing}
      <div class="chat-pane__session-trail">
        ${projectCrumb
          ? html`<span class="chat-pane__crumb-sep" aria-hidden="true">/</span>`
          : nothing}
        ${parentCrumb
          ? html`${parentCrumb}<span class="chat-pane__crumb-sep" aria-hidden="true">/</span>`
          : nothing}
        ${renderSessionCrumb(props)}
      </div>
    </div>
  `;
}

function renderParentSessionCrumb(props: ChatPaneHeaderProps): TemplateResult | null {
  const parent = props.parentSession;
  if (!parent) {
    return null;
  }
  const label = t("chat.sessionHeader.openParent", { title: parent.title });
  return html`<button
    class="chat-pane__parent-session"
    type="button"
    title=${label}
    aria-label=${label}
    @click=${() => props.onOpenParentSession(parent.key)}
  >
    <span class="chat-pane__parent-session-text">${parent.title}</span>
  </button>`;
}

function renderSessionCrumb(props: ChatPaneHeaderProps) {
  if (props.editing) {
    return html`<input
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
    />`;
  }
  return props.catalog || !props.session || props.renameDisabledReason
    ? html`<span class="chat-pane__session-title" title=${props.renameDisabledReason ?? props.title}
        >${renderSessionColorDot(props.catalog ? props.catalogColor : props.session?.color)}<span
          class="chat-pane__session-title-text"
          >${props.title}</span
        ></span
      >`
    : html`<button
        class="chat-pane__session-title chat-pane__session-title-button"
        type="button"
        title=${t("chat.sessionHeader.renameTooltip")}
        aria-label=${t("chat.sessionHeader.renameAria", { title: props.title })}
        @click=${props.onBeginRename}
      >
        ${renderSessionColorDot(props.catalog ? props.catalogColor : props.session?.color)}<span
          class="chat-pane__session-title-text"
          >${props.title}</span
        >
      </button>`;
}

function renderProjectCrumb(
  props: ChatPaneHeaderProps,
  copied: boolean,
  copyPathLabel: string,
  copyBranchLabel: string,
): TemplateResult | null {
  if (props.catalog || !props.workspaceLabel) {
    return null;
  }
  return html`
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
        class=${`chat-pane__workspace-chip${!copied && !props.workspaceIcon ? " chat-pane__workspace-chip--fallback-icon" : ""}`}
        type="button"
        title=${props.workspaceRoot ?? props.workspaceLabel}
        aria-label=${t("chat.sessionHeader.workspaceAria", {
          workspace: props.workspaceLabel,
        })}
      >
        ${copied ? icons.check : renderWorkspaceChipIcon(props.workspaceIcon)}<span
          >${copied ? t("chat.sessionHeader.copied") : props.workspaceLabel}</span
        >
      </button>
      ${props.canReveal && props.workspaceRoot
        ? html`<wa-dropdown-item value="reveal">${revealLabel(props.platform)}</wa-dropdown-item>`
        : nothing}
      ${props.workspaceRoot
        ? html`<wa-dropdown-item value="copy-path">${copyPathLabel}</wa-dropdown-item>`
        : nothing}
      ${props.branch
        ? html`<wa-dropdown-item value="copy-branch">${copyBranchLabel}</wa-dropdown-item>`
        : nothing}
    </wa-dropdown>
  `;
}

function renderWorkspaceChipIcon(icon: ChatPaneHeaderProps["workspaceIcon"]) {
  return icon
    ? html`<openclaw-workspace-icon
        .routeUrl=${icon.routeUrl}
        .authTokens=${icon.authTokens}
        .authReady=${icon.authReady}
      ></openclaw-workspace-icon>`
    : icons.folder;
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

function gatewayHealthLabel(gateway: NativeGateway): string {
  if (gateway.health === "ok") {
    return t("chat.sessionHeader.gatewayPicker.connected");
  }
  if (gateway.health === "error") {
    return t("chat.sessionHeader.gatewayPicker.unreachable");
  }
  return t("chat.sessionHeader.gatewayPicker.unknown");
}

function renderGatewayPicker(props: ChatPaneHeaderProps) {
  const capability = props.nativeGateways;
  const snapshot = props.gatewaysSnapshot;
  if (
    !capability ||
    !snapshot ||
    snapshot.gateways.length <= 1 ||
    props.onboarding ||
    !isNativeWebChromeHost()
  ) {
    return nothing;
  }
  const current = snapshot.gateways.find((gateway) => gateway.id === snapshot.currentId);
  if (!current) {
    return nothing;
  }
  const setPrimaryDisabled = current.isPrimary || !current.canPromote;
  return html`
    <wa-dropdown class="chat-pane__gateway-menu" placement="bottom-start">
      <button
        slot="trigger"
        class="chat-pane__gateway-chip"
        type="button"
        aria-label=${t("chat.sessionHeader.gatewayPicker.menuLabel", { gateway: current.name })}
      >
        <span class="chat-pane__gateway-health" data-health=${current.health}></span>
        <span class="chat-pane__gateway-name">${current.name}</span>
        <span class="chat-pane__gateway-chevron">${icons.chevronUp}</span>
      </button>
      ${snapshot.gateways.map((gateway) => {
        const selected = gateway.id === snapshot.currentId;
        return html`<wa-dropdown-item
          class="chat-pane__gateway-menu-item chat-pane__gateway-item"
          role="menuitemradio"
          aria-checked=${String(selected)}
          ${ref((element) => syncDropdownItemRadio(element, selected))}
          @click=${(event: MouseEvent) => {
            if (event.altKey) {
              capability.openWindow(gateway.id);
            } else if (!selected) {
              capability.select(gateway.id);
            }
          }}
        >
          <span
            slot="icon"
            class="chat-pane__gateway-health"
            data-health=${gateway.health}
            role="img"
            aria-label=${gatewayHealthLabel(gateway)}
          ></span>
          <span>${gateway.name}</span>
          <span slot="details" class="chat-pane__gateway-details">
            ${gateway.isPrimary
              ? html`<span class="chat-pane__gateway-primary"
                  >${t("chat.sessionHeader.gatewayPicker.primaryTag")}</span
                >`
              : nothing}
            ${selected
              ? html`<span class="chat-pane__gateway-check">${icons.check}</span>`
              : nothing}
          </span>
        </wa-dropdown-item>`;
      })}
      <div class="chat-pane__gateway-divider" role="separator"></div>
      <wa-dropdown-item
        class="chat-pane__gateway-menu-item"
        ?disabled=${setPrimaryDisabled}
        @click=${() => !setPrimaryDisabled && capability.setPrimary(current.id)}
        >${t("chat.sessionHeader.gatewayPicker.setPrimary")}</wa-dropdown-item
      >
      <wa-dropdown-item
        class="chat-pane__gateway-menu-item"
        @click=${() => capability.openSettings()}
        >${t("chat.sessionHeader.gatewayPicker.openSettings")}</wa-dropdown-item
      >
    </wa-dropdown>
  `;
}

export function renderChatPaneHeader(props: ChatPaneHeaderProps) {
  const copyPathLabel =
    props.copiedAction === "copy-path"
      ? t("chat.sessionHeader.copied")
      : t("chat.sessionHeader.copyPath");
  const copyBranchLabel =
    props.copiedAction === "copy-branch"
      ? t("chat.sessionHeader.copied")
      : t("chat.sessionHeader.copyBranch");
  const copied = props.copiedAction === "copy-path" || props.copiedAction === "copy-branch";
  const drawerLabel = props.navDrawerOpen ? t("nav.collapse") : t("nav.expand");
  const compactSessionActions = props.narrow && props.sessionMenuAction !== nothing;

  return html`
    <div class="chat-pane__header" @mousedown=${beginNativeWindowDrag}>
      ${props.mergedChrome
        ? html`<openclaw-tooltip .content=${drawerLabel}>
            <button
              class="btn btn--ghost btn--icon chat-icon-btn chat-pane__nav-toggle"
              type="button"
              aria-label=${drawerLabel}
              aria-expanded=${String(Boolean(props.navDrawerOpen))}
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
      ${props.session?.incognito
        ? html`<span
            class="chat-pane__incognito"
            role="img"
            aria-label=${t("chat.sessionHeader.incognito")}
            title=${t("chat.sessionHeader.incognito")}
            >${icons.lock}</span
          >`
        : nothing}
      ${renderIdentityCrumbs(props, copied, copyPathLabel, copyBranchLabel)}
      ${renderStandalonePersonLink(
        renderSessionOwnerChip(
          props.showOwnerChip ? props.session?.owner?.actor : undefined,
          "header",
          props.session?.owner?.assignedAt !== undefined ? "owned" : "created",
          props.ownerViewing,
        ),
        props.showOwnerChip
          ? personActivityLink(
              props.session?.owner?.actor.identity?.type === "profile"
                ? props.session.owner.actor.identity.id
                : undefined,
              props.personActivity,
            )
          : null,
      )}
      ${props.showOwnerChip && props.session?.participants?.length
        ? html`<openclaw-viewer-facepile
            class="chat-pane__participants"
            .staticParticipants=${props.session.participants}
            .totalCount=${props.session.participantCount}
            .maxVisible=${4}
            .personActivity=${props.personActivity}
            variant="session"
          ></openclaw-viewer-facepile>`
        : nothing}
      ${props.placementControl ?? nothing} ${props.presence ?? nothing}
      ${props.faceControl ?? nothing} ${props.sharingControl ?? nothing}
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
              <button
                slot="trigger"
                class="btn btn--ghost btn--icon chat-icon-btn chat-pane__branches-trigger"
                type="button"
                ?disabled=${Boolean(props.branchSwitchDisabledReason)}
                title=${props.branchSwitchDisabledReason ?? t("chat.sessionHeader.branches")}
                aria-label=${t("chat.sessionHeader.branches")}
              >
                ${icons.gitBranch}
              </button>
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
      ${renderGatewayPicker(props)}
      <div class="chat-pane__actions">
        ${compactSessionActions ? nothing : props.panelActions}
        ${compactSessionActions ? nothing : props.discussionAction}
        ${props.catalog || compactSessionActions
          ? nothing
          : html`${props.diffAction} ${props.backgroundTasksAction} ${props.workspaceAction}
            ${props.sessionRailAction}`}
        ${props.onOpenSplitView && !compactSessionActions
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
                class="btn btn--ghost btn--icon chat-icon-btn chat-pane__split-down"
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
                class="btn btn--ghost btn--icon chat-icon-btn chat-pane__split-right"
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
                class="btn btn--ghost btn--icon chat-icon-btn chat-pane__close-pane"
                type="button"
                aria-label=${t("chat.splitView.closePane")}
                @click=${() => props.onClosePane?.(props.paneId)}
              >
                ${icons.x}
              </button>
            </openclaw-tooltip>`
          : nothing}
        ${props.mergedChrome && !compactSessionActions
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
        ${props.sessionMenuAction}
      </div>
    </div>
  `;
}
