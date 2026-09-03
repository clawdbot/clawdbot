import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { DropdownMenuController } from "./dropdown-menu-controller.ts";
import { icons } from "./icons.ts";
import { activateMenuShortcut, menuShortcutHint } from "./menu-shortcuts.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";
import {
  EMPTY_SESSION_MENU_DATA,
  SessionMenuActions,
  type SessionManagementAction,
  type SessionMenuData,
} from "./session-menu-actions.ts";
import {
  compactSessionMenuViewForValue,
  type CompactSessionMenuView,
} from "./session-menu-compact.ts";
import type { SessionCreatedActor } from "./session-owner-chip.ts";

/**
 * Worktree-session extras resolved lazily by the menu host after open.
 * Only resolved destinations are offered. A null `worktreePath` hides editor
 * destinations — see
 * `native-editor-locality.runtime.ts` for which checkouts ever get one.
 */
export type SessionMenuWork = {
  loading: boolean;
  pullRequestUrl: string | null;
  worktreePath: string | null;
};

export type SessionMenuAction =
  | SessionManagementAction
  | { kind: "open-pr"; url: string }
  | { kind: "workboard" }
  | { kind: "stop-cloud-worker" };

export type SessionMenuActionKind = SessionMenuAction["kind"];

class SessionMenu extends OpenClawLightDomElement {
  @property({ attribute: false }) session: SessionMenuData = EMPTY_SESSION_MENU_DATA;
  @property({ attribute: false }) compact = false;
  @property({ attribute: false }) navigationAllowed = false;
  @property({ attribute: false }) copyMarkdownAllowed = false;
  @property({ attribute: false }) splitAllowed = false;
  // >1 renders the batch menu: only actions that apply to every selected
  // session (unread/group/archive/delete); `session` then carries aggregated
  // flags (unread = all unread, category = shared category or null).
  @property({ attribute: false }) selectionCount = 1;
  @property({ attribute: false }) lastActive = "";
  @property({ attribute: false }) anchor: { x: number; y: number } = { x: 0, y: 0 };
  @property({ attribute: false }) trigger: HTMLElement | null = null;
  @property({ attribute: false }) disabled = false;
  @property({ attribute: false }) actionDisabledReasons: Partial<
    Record<SessionMenuActionKind, string>
  > = {};
  @property({ attribute: false }) forkDisabled = false;
  @property({ attribute: false }) forkFromLastCompleted = false;
  @property({ attribute: false }) archiveAllowed = false;
  @property({ attribute: false }) deleteAllowed = false;
  @property({ attribute: false }) cloudWorkerStopAllowed = false;
  @property({ attribute: false }) groups: readonly string[] = [];
  @property({ attribute: false }) currentOwner: SessionCreatedActor | null = null;
  @property({ attribute: false }) work: SessionMenuWork | null = null;
  @property({ attribute: false }) workboard: { captured: boolean; busy: boolean } | null = null;
  @property({ attribute: false }) onAction: (action: SessionMenuAction) => void = () => {};
  @property({ attribute: false }) onClose: () => void = () => {};
  @state() private compactView: CompactSessionMenuView = "root";
  private readonly managementActions = new SessionMenuActions(
    this,
    () => ({
      session: this.session,
      selectionCount: this.selectionCount,
      compact: this.compact,
      navigationAllowed: this.navigationAllowed,
      copyMarkdownAllowed: this.copyMarkdownAllowed,
      splitAllowed: this.splitAllowed,
      disabled: this.disabled,
      actionDisabledReasons: this.actionDisabledReasons,
      forkDisabled: this.forkDisabled,
      forkFromLastCompleted: this.forkFromLastCompleted,
      archiveAllowed: this.archiveAllowed,
      deleteAllowed: this.deleteAllowed,
      groups: this.groups,
      currentOwner: this.currentOwner,
      worktreePath: this.work?.worktreePath ?? null,
    }),
    (action) => this.onAction(action),
    () => this.onClose(),
  );
  readonly menuLifecycle = new DropdownMenuController(this, {
    getTrigger: () => this.trigger,
    onClose: () => this.onClose(),
    onKeydown: (event) => {
      if (!this.managementActions.handleKeydown(event)) {
        activateMenuShortcut(this, event);
      }
    },
  });

  override connectedCallback() {
    super.connectedCallback();
    // Sidebar-hosted menus live inside the nav stacking context (z-index 10),
    // which paints below the sidebar resizer divider (z-index 20); promoting
    // the menu to the popover top layer keeps app chrome from bleeding
    // through it (same pattern as openclaw-native-link-menu).
    promoteToPopoverTopLayer(this);
  }

  private runAction(action: SessionMenuAction) {
    if (this.actionDisabledReasons[action.kind]) {
      return;
    }
    this.onClose();
    this.onAction(action);
  }

  private actionDisabled(kind: SessionMenuActionKind, extra = false): boolean {
    return this.disabled || extra || Boolean(this.actionDisabledReasons[kind]);
  }

  private actionTitle(kind: SessionMenuActionKind): string | typeof nothing {
    return this.actionDisabledReasons[kind] ?? nothing;
  }

  private readonly handleSelect = (event: CustomEvent<{ item: { value?: string } }>) => {
    event.preventDefault();
    const value = event.detail.item.value;
    if (!value) {
      return;
    }
    const compactView = compactSessionMenuViewForValue(value);
    if (compactView) {
      this.compactView = compactView;
      this.managementActions.prepareCompactView(compactView);
      this.managementActions.focusCurrentView();
      return;
    }
    if (this.managementActions.handleSelect(value)) {
      return;
    }
    if (value === "workboard" || value === "stop-cloud-worker") {
      this.runAction({ kind: value });
      return;
    }
    if (value === "open-pr" && this.work?.pullRequestUrl) {
      this.runAction({ kind: "open-pr", url: this.work.pullRequestUrl });
    }
  };

  private readonly handleAfterHide = (event: Event) => {
    // A keyed replacement can finish hiding after its successor opens.
    if (event.currentTarget instanceof Node && event.currentTarget.isConnected) {
      this.onClose();
    }
  };

  private renderWorkItems() {
    const pullRequestUrl = this.work?.pullRequestUrl;
    if (!pullRequestUrl) {
      return nothing;
    }
    return html`
      <wa-dropdown-item
        class="session-menu__item"
        value="open-pr"
        data-new-tab-action
        data-shortcut="g"
        aria-keyshortcuts="G"
        ?disabled=${this.disabled || !pullRequestUrl}
      >
        <span slot="icon" class="session-menu__icon" aria-hidden="true"
          >${icons.gitPullRequest}</span
        >
        <span class="session-menu__text">${t("sessionsView.openPullRequest")}</span>
        ${menuShortcutHint("g")}
      </wa-dropdown-item>
    `;
  }

  override render() {
    const menuWidth = 240;
    const menuMaxHeight = 460;
    const clampedX = Math.max(8, Math.min(this.anchor.x, window.innerWidth - menuWidth - 8));
    const clampedY = Math.max(8, Math.min(this.anchor.y, window.innerHeight - menuMaxHeight - 8));
    const session = this.session;
    const batch = this.selectionCount > 1;
    const count = String(this.selectionCount);
    const menuLabel = batch
      ? t("chat.sidebar.sessionMenuMany", { count })
      : t("chat.sidebar.sessionMenu", { session: session.label });
    return keyed(
      this.anchor,
      html`<wa-dropdown
        class=${`session-menu${this.compact ? " session-menu--compact" : ""}`}
        .open=${true}
        placement="bottom-start"
        .distance=${0}
        aria-label=${menuLabel}
        @wa-show=${this.managementActions.loadOwners}
        @wa-select=${this.handleSelect}
        @wa-after-hide=${this.handleAfterHide}
      >
        <button
          slot="trigger"
          type="button"
          tabindex="-1"
          aria-hidden="true"
          aria-label=${menuLabel}
          style="position: fixed; left: ${clampedX}px; top: ${clampedY}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
        ></button>
        ${this.compact && this.compactView !== "root"
          ? this.managementActions.renderCompactView(this.compactView)
          : html`
              ${!batch && this.lastActive
                ? html`<div class="session-menu__info">
                    ${t("sessionsView.lastActive", { time: this.lastActive })}
                  </div>`
                : nothing}
              ${this.managementActions.renderPrimaryActions()}
              <div class="session-menu__separator" role="separator"></div>
              ${this.managementActions.renderOrganizationActions()}
              ${!batch && this.workboard
                ? html`
                    <wa-dropdown-item
                      class="session-menu__item"
                      value="workboard"
                      data-shortcut="w"
                      aria-keyshortcuts="W"
                      ?disabled=${this.disabled || this.workboard.busy}
                    >
                      <span slot="icon" class="session-menu__icon" aria-hidden="true"
                        >${this.workboard.captured ? icons.check : icons.plus}</span
                      >
                      <span class="session-menu__text"
                        >${this.workboard.captured
                          ? t("sessionsView.openWorkboardCard")
                          : t("sessionsView.addToWorkboard")}</span
                      >
                      ${menuShortcutHint("w")}
                    </wa-dropdown-item>
                  `
                : nothing}
              ${batch
                ? nothing
                : html`
                    <div class="session-menu__separator" role="separator"></div>
                    ${this.managementActions.renderTransferActions()} ${this.renderWorkItems()}
                  `}
              <div class="session-menu__separator" role="separator"></div>
              ${!batch && this.cloudWorkerStopAllowed
                ? html`
                    <wa-dropdown-item
                      class="session-menu__item session-menu__item--destructive"
                      value="stop-cloud-worker"
                      variant="danger"
                      ?disabled=${this.actionDisabled("stop-cloud-worker")}
                      title=${this.actionTitle("stop-cloud-worker")}
                    >
                      <span slot="icon" class="session-menu__icon" aria-hidden="true"
                        >${icons.stop}</span
                      >
                      <span class="session-menu__text">${t("sessionsView.stopCloudWorker")}</span>
                    </wa-dropdown-item>
                  `
                : nothing}
              ${this.managementActions.renderDeleteAction()}
            `}
      </wa-dropdown>`,
    );
  }
}

if (!customElements.get("openclaw-session-menu")) {
  customElements.define("openclaw-session-menu", SessionMenu);
}
