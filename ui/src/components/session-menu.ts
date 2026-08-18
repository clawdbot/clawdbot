import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { normalizeSessionIconValue } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { t } from "../i18n/index.ts";
import { EDITOR_IDS, EDITOR_LABELS, type EditorId } from "../lib/editor-links.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { DropdownMenuController } from "./dropdown-menu-controller.ts";
import { icons } from "./icons.ts";
import { activateMenuShortcut, menuShortcutHint } from "./menu-shortcuts.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";
import { renderSessionIconPicker } from "./session-icon-picker.ts";
import { renderSessionOwnerMenuAvatar, type SessionOwnerOption } from "./session-owner-chip.ts";
import { syncDropdownItemRadio } from "./web-awesome.ts";

type SessionMenuData = {
  label: string;
  isChild?: boolean;
  pinned: boolean;
  unread: boolean;
  archived: boolean;
  category: string | null;
  icon: string | null;
  categoryClearReturnsToGroups: boolean;
};

/**
 * Worktree-session extras resolved lazily by the menu host after open; null
 * hides the block entirely (plain chat sessions), loading keeps the items
 * rendered-but-disabled so the menu layout never shifts under the pointer.
 */
export type SessionMenuWork = {
  loading: boolean;
  pullRequestUrl: string | null;
  worktreePath: string | null;
};

export type SessionMenuAction =
  | { kind: "open-pr"; url: string }
  | { kind: "open-in"; editor: EditorId; path: string }
  | { kind: "toggle-pin" }
  | { kind: "toggle-unread" }
  | { kind: "rename" }
  | { kind: "set-icon"; icon: string | null }
  | { kind: "assign-owner"; owner: Pick<SessionOwnerOption, "type" | "id"> }
  | { kind: "fork" }
  | { kind: "workboard" }
  | { kind: "move-to-group"; category: string | null }
  | { kind: "new-group" }
  | { kind: "toggle-archived" }
  | { kind: "stop-cloud-worker" }
  | { kind: "delete" };

export type SessionMenuActionKind = SessionMenuAction["kind"];

const EMPTY_SESSION: SessionMenuData = {
  label: "",
  isChild: false,
  pinned: false,
  unread: false,
  archived: false,
  category: null,
  icon: null,
  categoryClearReturnsToGroups: false,
};

const SESSION_ICON_GRID_COLUMNS = 6;

class SessionMenu extends OpenClawLightDomElement {
  @property({ attribute: false }) session: SessionMenuData = EMPTY_SESSION;
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
  @property({ attribute: false }) ownerOptions: readonly SessionOwnerOption[] = [];
  @property({ attribute: false }) selfOwner: SessionOwnerOption | null = null;
  @property({ attribute: false }) currentOwnerId: string | null = null;
  @property({ attribute: false }) work: SessionMenuWork | null = null;
  @property({ attribute: false }) workboard: { captured: boolean; busy: boolean } | null = null;
  @property({ attribute: false }) onAction: (action: SessionMenuAction) => void = () => {};
  @property({ attribute: false }) onClose: () => void = () => {};
  @state() private iconPickerMode: "grid" | "custom" = "grid";
  @state() private customIconValue = "";
  readonly menuLifecycle = new DropdownMenuController(this, {
    getTrigger: () => this.trigger,
    onClose: () => this.onClose(),
    onKeydown: (event) => this.handleMenuKeydown(event),
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
    const simpleActions: Partial<Record<string, SessionMenuAction>> = {
      "toggle-pin": { kind: "toggle-pin" },
      "toggle-unread": { kind: "toggle-unread" },
      rename: { kind: "rename" },
      fork: { kind: "fork" },
      workboard: { kind: "workboard" },
      "new-group": { kind: "new-group" },
      "toggle-archived": { kind: "toggle-archived" },
      "stop-cloud-worker": { kind: "stop-cloud-worker" },
      delete: { kind: "delete" },
    };
    const simpleAction = simpleActions[value];
    if (simpleAction) {
      this.runAction(simpleAction);
      return;
    }
    if (value === "open-pr" && this.work?.pullRequestUrl) {
      this.runAction({ kind: "open-pr", url: this.work.pullRequestUrl });
      return;
    }
    if (value.startsWith("open-in:") && this.work?.worktreePath) {
      const editor = value.slice("open-in:".length) as EditorId;
      if (EDITOR_IDS.includes(editor)) {
        this.runAction({ kind: "open-in", editor, path: this.work.worktreePath });
      }
      return;
    }
    if (value.startsWith("move-to-group:")) {
      const encodedCategory = value.slice("move-to-group:".length);
      this.runAction({
        kind: "move-to-group",
        category: encodedCategory ? decodeURIComponent(encodedCategory) : null,
      });
      return;
    }
    if (value.startsWith("set-icon:")) {
      const encodedIcon = value.slice("set-icon:".length);
      this.runAction({
        kind: "set-icon",
        icon: encodedIcon ? decodeURIComponent(encodedIcon) : null,
      });
      return;
    }
    if (value === "assign-owner:self" && this.selfOwner) {
      this.runAction({ kind: "assign-owner", owner: this.selfOwner });
      return;
    }
    if (value.startsWith("assign-owner:")) {
      const [, type, encodedId] = value.split(":");
      const id = encodedId ? decodeURIComponent(encodedId) : "";
      if ((type === "human" || type === "agent") && id) {
        this.runAction({ kind: "assign-owner", owner: { type, id } });
      }
    }
  };

  private renderOwnerSubmenu() {
    return this.ownerOptions.map((owner) => {
      const checked = owner.id === this.currentOwnerId;
      return html`
        <wa-dropdown-item
          slot="submenu"
          class="session-menu__item"
          value=${`assign-owner:${owner.type}:${encodeURIComponent(owner.id)}`}
          role="menuitemradio"
          aria-checked=${String(checked)}
          ${ref((element) => syncDropdownItemRadio(element, checked))}
          ?disabled=${this.actionDisabled("assign-owner", checked)}
          title=${this.actionTitle("assign-owner")}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true"
            >${renderSessionOwnerMenuAvatar(owner)}</span
          >
          <span class="session-menu__text">${owner.label ?? owner.id}</span>
          ${checked
            ? html`<span slot="details" class="session-menu__check" aria-hidden="true"
                >${icons.check}</span
              >`
            : nothing}
        </wa-dropdown-item>
      `;
    });
  }

  private readonly handleAfterHide = (event: Event) => {
    // A keyed replacement can finish hiding after its successor opens.
    if (event.currentTarget instanceof Node && event.currentTarget.isConnected) {
      this.onClose();
    }
  };

  private renderWorkItems() {
    const work = this.work;
    if (!work) {
      return nothing;
    }
    const pullRequestUrl = work.pullRequestUrl;
    const worktreePath = work.worktreePath;
    return html`
      <wa-dropdown-item
        class="session-menu__item"
        value="open-pr"
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
      <wa-dropdown-item class="session-menu__item" ?disabled=${this.disabled || !worktreePath}>
        <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.externalLink}</span>
        <span class="session-menu__text">${t("sessionsView.openInEditorMenu")}</span>
        ${worktreePath ? this.renderEditorSubmenu() : nothing}
      </wa-dropdown-item>
      <div class="session-menu__separator" role="separator"></div>
    `;
  }

  private renderEditorSubmenu() {
    return html`
      ${EDITOR_IDS.map(
        (editor) => html`
          <wa-dropdown-item
            slot="submenu"
            class="session-menu__item"
            value=${`open-in:${editor}`}
            ?disabled=${this.disabled}
          >
            <span class="session-menu__text">${EDITOR_LABELS[editor]}</span>
          </wa-dropdown-item>
        `,
      )}
    `;
  }

  private renderGroupSubmenu() {
    const session = this.session;
    // Entries are numbered like the digits users see: existing groups first,
    // then the ungroup entry, then New group…; entries past 9 stay unnumbered
    // rather than reusing digits.
    let nextDigit = 1;
    const takeDigit = () => (nextDigit <= 9 ? String(nextDigit++) : null);
    const entry = (label: string, checked: boolean, value: string, radio = true) => {
      const digit = takeDigit();
      const actionKind = value === "new-group" ? "new-group" : "move-to-group";
      return html`
        <wa-dropdown-item
          slot="submenu"
          class="session-menu__item"
          value=${value}
          role=${radio ? "menuitemradio" : "menuitem"}
          aria-checked=${radio ? String(checked) : nothing}
          ${radio ? ref((element) => syncDropdownItemRadio(element, checked)) : nothing}
          data-shortcut=${digit ?? nothing}
          aria-keyshortcuts=${digit ?? nothing}
          ?disabled=${this.actionDisabled(actionKind)}
          title=${this.actionTitle(actionKind)}
        >
          <span class="session-menu__text">${label}</span>
          ${radio && checked
            ? html`<span slot="details" class="session-menu__check" aria-hidden="true"
                >${icons.check}</span
              >`
            : nothing}
          ${digit ? menuShortcutHint(digit) : nothing}
        </wa-dropdown-item>
      `;
    };
    return html`
      ${this.groups.map((group) =>
        entry(group, session.category === group, `move-to-group:${encodeURIComponent(group)}`),
      )}
      ${session.category
        ? entry(
            t(
              session.categoryClearReturnsToGroups
                ? "sessionsView.moveBackToGroups"
                : "sessionsView.removeFromGroup",
            ),
            false,
            "move-to-group:",
            false,
          )
        : nothing}
      ${entry(t("sessionsView.newGroup"), false, "new-group", false)}
    `;
  }

  private renderIconSubmenu() {
    return renderSessionIconPicker({
      mode: this.iconPickerMode,
      currentIcon: this.session.icon,
      customIconValue: this.customIconValue,
      disabled: this.actionDisabled("set-icon"),
      disabledReason: this.actionDisabledReasons["set-icon"],
      onSelect: this.selectIcon,
      onShowCustom: this.showCustomIconEntry,
      onBack: this.showIconGrid,
      onInput: this.updateCustomIconValue,
      onApply: this.applyCustomIcon,
      onRemove: this.removeIcon,
      onGridKeydown: this.handleIconGridKeydown,
    });
  }

  private readonly selectIcon = (event: MouseEvent, icon: string) => {
    event.stopPropagation();
    this.runAction({ kind: "set-icon", icon });
  };

  private readonly showCustomIconEntry = (event: MouseEvent) => {
    event.stopPropagation();
    this.iconPickerMode = "custom";
    this.customIconValue = "";
    void this.updateComplete.then(() => {
      this.querySelector<HTMLInputElement>(".session-menu__icon-custom-input")?.focus();
    });
  };

  private readonly showIconGrid = (event?: Event) => {
    event?.stopPropagation();
    this.iconPickerMode = "grid";
    this.customIconValue = "";
    void this.updateComplete.then(() => {
      this.querySelector<HTMLButtonElement>(".session-menu__icon-choice--custom")?.focus();
    });
  };

  private readonly updateCustomIconValue = (event: InputEvent) => {
    if (event.currentTarget instanceof HTMLInputElement) {
      this.customIconValue = event.currentTarget.value;
    }
  };

  private readonly applyCustomIcon = (event?: Event) => {
    event?.stopPropagation();
    const icon = normalizeSessionIconValue(this.customIconValue);
    if (icon) {
      this.runAction({ kind: "set-icon", icon });
    }
  };

  private handleMenuKeydown(event: KeyboardEvent) {
    const input = event
      .composedPath()
      .find(
        (target): target is HTMLInputElement =>
          target instanceof HTMLInputElement &&
          target.classList.contains("session-menu__icon-custom-input"),
      );
    if (!input) {
      activateMenuShortcut(this, event);
      return;
    }
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      this.showIconGrid();
    } else if (event.key === "Enter") {
      const icon = normalizeSessionIconValue(input.value);
      if (icon) {
        event.preventDefault();
        this.customIconValue = input.value;
        this.applyCustomIcon();
      }
    }
  }

  private readonly removeIcon = (event: MouseEvent) => {
    event.stopPropagation();
    this.runAction({ kind: "set-icon", icon: null });
  };

  private readonly handleIconGridKeydown = (event: KeyboardEvent) => {
    const choice = event.target;
    if (!(choice instanceof HTMLButtonElement)) {
      return;
    }
    const offsets: Partial<Record<string, number>> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -SESSION_ICON_GRID_COLUMNS,
      ArrowDown: SESSION_ICON_GRID_COLUMNS,
    };
    const offset = offsets[event.key];
    if (offset === undefined) {
      return;
    }
    const grid = event.currentTarget;
    if (!(grid instanceof HTMLElement)) {
      return;
    }
    const choices = Array.from(
      grid.querySelectorAll<HTMLButtonElement>(".session-menu__icon-choice:not(:disabled)"),
    );
    const index = choices.indexOf(choice);
    if (index < 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const nextIndex = (index + offset + choices.length) % choices.length;
    choices.forEach((button, buttonIndex) => {
      button.tabIndex = buttonIndex === nextIndex ? 0 : -1;
    });
    choices[nextIndex]?.focus();
  };

  private readonly focusIconGridOnOpen = (event: CustomEvent<{ item: HTMLElement }>) => {
    const item = event.currentTarget;
    if (!(item instanceof HTMLElement) || event.detail.item !== item) {
      return;
    }
    // Web Awesome re-runs submenu setup when grid/custom content replaces the
    // slot. Only a closed submenu is a user reopen that should reset state.
    if (item.getAttribute("aria-expanded") === "true") {
      return;
    }
    this.iconPickerMode = "grid";
    this.customIconValue = "";
    void this.updateComplete.then(() =>
      requestAnimationFrame(() => {
        item.querySelector<HTMLButtonElement>('.session-menu__icon-choice[tabindex="0"]')?.focus();
      }),
    );
  };

  override render() {
    const menuWidth = 240;
    const menuMaxHeight = 460;
    const clampedX = Math.max(8, Math.min(this.anchor.x, window.innerWidth - menuWidth - 8));
    const clampedY = Math.max(8, Math.min(this.anchor.y, window.innerHeight - menuMaxHeight - 8));
    const session = this.session;
    const batch = this.selectionCount > 1;
    // Pinning and grouping place root rows; child placement is owned by lineage.
    const rootPlacementActions = session.isChild !== true;
    const count = String(this.selectionCount);
    const menuLabel = batch
      ? t("chat.sidebar.sessionMenuMany", { count })
      : t("chat.sidebar.sessionMenu", { session: session.label });
    return keyed(
      this.anchor,
      html`<wa-dropdown
        class="session-menu"
        .open=${true}
        placement="bottom-start"
        .distance=${0}
        aria-label=${menuLabel}
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
        ${!batch && this.lastActive
          ? html`<div class="session-menu__info">
              ${t("sessionsView.lastActive", { time: this.lastActive })}
            </div>`
          : nothing}
        ${batch ? nothing : this.renderWorkItems()}
        ${batch || !rootPlacementActions
          ? nothing
          : html`
              <wa-dropdown-item
                class="session-menu__item"
                value="toggle-pin"
                data-shortcut="p"
                aria-keyshortcuts="P"
                ?disabled=${this.actionDisabled("toggle-pin", session.archived)}
                title=${this.actionTitle("toggle-pin")}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true"
                  >${session.pinned ? icons.pinOff : icons.pin}</span
                >
                <span class="session-menu__text"
                  >${session.pinned
                    ? t("sessionsView.unpinSession")
                    : t("sessionsView.pinSession")}</span
                >
                ${menuShortcutHint("p")}
              </wa-dropdown-item>
            `}
        <wa-dropdown-item
          class="session-menu__item"
          value="toggle-unread"
          data-shortcut="u"
          aria-keyshortcuts="U"
          ?disabled=${this.actionDisabled("toggle-unread")}
          title=${this.actionTitle("toggle-unread")}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true"
            >${session.unread ? icons.eye : icons.circle}</span
          >
          <span class="session-menu__text"
            >${batch
              ? session.unread
                ? t("sessionsView.markReadCount", { count })
                : t("sessionsView.markUnreadCount", { count })
              : session.unread
                ? t("sessionsView.markRead")
                : t("sessionsView.markUnread")}</span
          >
          ${menuShortcutHint("u")}
        </wa-dropdown-item>
        ${batch
          ? nothing
          : html`
              <wa-dropdown-item
                class="session-menu__item"
                value="rename"
                data-shortcut="r"
                aria-keyshortcuts="R"
                ?disabled=${this.actionDisabled("rename")}
                title=${this.actionTitle("rename")}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.edit}</span>
                <span class="session-menu__text">${t("sessionsView.renameSessionMenu")}</span>
                ${menuShortcutHint("r")}
              </wa-dropdown-item>
              ${this.selfOwner
                ? html`<wa-dropdown-item
                    class="session-menu__item"
                    value="assign-owner:self"
                    ?disabled=${this.actionDisabled(
                      "assign-owner",
                      this.currentOwnerId === this.selfOwner.id,
                    )}
                    title=${this.actionTitle("assign-owner")}
                  >
                    <span slot="icon" class="session-menu__icon" aria-hidden="true"
                      >${icons.users}</span
                    >
                    <span class="session-menu__text">${t("sessionsView.assignToMe")}</span>
                  </wa-dropdown-item>`
                : nothing}
              ${this.ownerOptions.length > 0
                ? html`<wa-dropdown-item
                    class="session-menu__item"
                    ?disabled=${this.actionDisabled("assign-owner")}
                    title=${this.actionTitle("assign-owner")}
                  >
                    <span slot="icon" class="session-menu__icon" aria-hidden="true"
                      >${icons.users}</span
                    >
                    <span class="session-menu__text">${t("sessionsView.assignTo")}</span>
                    ${this.renderOwnerSubmenu()}
                  </wa-dropdown-item>`
                : nothing}
              <wa-dropdown-item
                class="session-menu__item"
                data-shortcut="i"
                aria-keyshortcuts="I"
                ?disabled=${this.actionDisabled("set-icon")}
                title=${this.actionTitle("set-icon")}
                @submenu-opening=${this.focusIconGridOnOpen}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.star}</span>
                <span class="session-menu__text">${t("sessionsView.setIconMenu")}</span>
                ${menuShortcutHint("i")} ${this.renderIconSubmenu()}
              </wa-dropdown-item>
              <wa-dropdown-item
                class="session-menu__item"
                value="fork"
                data-shortcut="f"
                aria-keyshortcuts="F"
                ?disabled=${this.actionDisabled("fork", this.forkDisabled)}
                title=${this.actionTitle("fork")}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.copy}</span>
                <span class="session-menu__text"
                  >${t(
                    this.forkFromLastCompleted
                      ? "sessionsView.forkFromLastCompleted"
                      : "sessionsView.forkSession",
                  )}</span
                >
                ${menuShortcutHint("f")}
              </wa-dropdown-item>
            `}
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
        ${rootPlacementActions
          ? html`<wa-dropdown-item
              class="session-menu__item"
              ?disabled=${this.actionDisabled("move-to-group")}
              title=${this.actionTitle("move-to-group")}
            >
              <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.folder}</span>
              <span class="session-menu__text"
                >${batch
                  ? t("sessionsView.moveToGroupMenuCount", { count })
                  : t("sessionsView.moveToGroupMenu")}</span
              >
              ${this.renderGroupSubmenu()}
            </wa-dropdown-item>`
          : nothing}
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
                <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.stop}</span>
                <span class="session-menu__text">${t("sessionsView.stopCloudWorker")}</span>
              </wa-dropdown-item>
            `
          : nothing}
        <wa-dropdown-item
          class="session-menu__item"
          value="toggle-archived"
          data-shortcut="a"
          aria-keyshortcuts="A"
          ?disabled=${this.actionDisabled(
            "toggle-archived",
            !batch && !session.archived && !this.archiveAllowed,
          )}
          title=${this.actionTitle("toggle-archived")}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true"
            >${session.archived ? icons.archiveRestore : icons.archive}</span
          >
          <span class="session-menu__text"
            >${batch
              ? session.archived
                ? t("sessionsView.restoreSessionCount", { count })
                : t("sessionsView.archiveSessionCount", { count })
              : session.archived
                ? t("sessionsView.restoreSession")
                : t("sessionsView.archiveSession")}</span
          >
          ${menuShortcutHint("a")}
        </wa-dropdown-item>
        <wa-dropdown-item
          class="session-menu__item session-menu__item--destructive"
          value="delete"
          variant="danger"
          data-shortcut="d"
          aria-keyshortcuts="D"
          ?disabled=${this.actionDisabled("delete", !this.deleteAllowed)}
          title=${this.actionTitle("delete")}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.trash}</span>
          <span class="session-menu__text"
            >${batch
              ? t("sessionsView.deleteSessionCount", { count })
              : t("sessionsView.deleteSessionMenu")}</span
          >
          ${menuShortcutHint("d")}
        </wa-dropdown-item>
      </wa-dropdown>`,
    );
  }
}

if (!customElements.get("openclaw-session-menu")) {
  customElements.define("openclaw-session-menu", SessionMenu);
}
