import { html, nothing, type ReactiveControllerHost } from "lit";
import {
  normalizeSessionColorValue,
  normalizeSessionIconValue,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { t } from "../i18n/index.ts";
import { EDITOR_IDS, type EditorId } from "../lib/editor-links.ts";
import { icons } from "./icons.ts";
import { menuShortcutHint } from "./menu-shortcuts.ts";
import { renderSessionIconPicker } from "./session-icon-picker.ts";
import {
  compactSessionOwnerOptions,
  renderCompactSessionMenuNavigationItem,
  renderCompactSessionMenuView,
  type CompactSessionMenuView,
} from "./session-menu-compact.ts";
import {
  renderSessionColorOptions,
  renderSessionEditorOptions,
  renderSessionGroupOptions,
} from "./session-menu-options.ts";
import type { SessionOwnerOption } from "./session-owner-chip.ts";
import {
  renderSessionOwnerAssignmentMenu,
  sessionOwnerAssignmentFromMenuValue,
} from "./session-owner-menu.ts";

export type SessionMenuData = {
  label: string;
  sessionId: string | null;
  isChild?: boolean;
  pinned: boolean;
  unread: boolean;
  archived: boolean;
  category: string | null;
  icon: string | null;
  color: string | null;
  categoryClearReturnsToGroups: boolean;
};

export type SessionManagementAction =
  | { kind: "open-in"; editor: EditorId; path: string }
  | { kind: "copy-session-id" }
  | { kind: "toggle-pin" }
  | { kind: "toggle-unread" }
  | { kind: "rename" }
  | { kind: "set-icon"; icon: string | null }
  | { kind: "set-color"; color: string | null }
  | { kind: "assign-owner"; owner: Pick<SessionOwnerOption, "type" | "id"> }
  | { kind: "fork" }
  | { kind: "move-to-group"; category: string | null }
  | { kind: "new-group" }
  | { kind: "toggle-archived" }
  | { kind: "delete" };

export type SessionManagementActionKind = SessionManagementAction["kind"];

export const EMPTY_SESSION_MENU_DATA: SessionMenuData = {
  label: "",
  sessionId: null,
  pinned: false,
  unread: false,
  archived: false,
  category: null,
  icon: null,
  color: null,
  categoryClearReturnsToGroups: false,
};

type SessionMenuActionsHost = ReactiveControllerHost &
  HTMLElement & { updateComplete: Promise<unknown> };

type SessionMenuActionsState = {
  session: SessionMenuData;
  selectionCount: number;
  compact: boolean;
  disabled: boolean;
  actionDisabledReasons: Partial<Record<SessionManagementActionKind, string>>;
  forkDisabled: boolean;
  forkFromLastCompleted: boolean;
  archiveAllowed: boolean;
  deleteAllowed: boolean;
  groups: readonly string[];
  ownerOptions: readonly SessionOwnerOption[];
  selfOwner: SessionOwnerOption | null;
  currentOwnerId: string | null;
  worktreePath: string | null;
};

const SESSION_ICON_GRID_COLUMNS = 6;

/** Canonical single-session actions shared by sidebar and chat-header menus. */
export class SessionMenuActions {
  private iconPickerMode: "grid" | "custom" = "grid";
  private customIconValue = "";

  constructor(
    private readonly host: SessionMenuActionsHost,
    private readonly readState: () => SessionMenuActionsState,
    private readonly onAction: (action: SessionManagementAction) => void,
    private readonly onClose: () => void,
  ) {}

  private actionDisabled(kind: SessionManagementActionKind, extra = false): boolean {
    const state = this.readState();
    return state.disabled || extra || Boolean(state.actionDisabledReasons[kind]);
  }

  private actionTitle(kind: SessionManagementActionKind): string | typeof nothing {
    return this.readState().actionDisabledReasons[kind] ?? nothing;
  }

  private actionExtraDisabled(kind: SessionManagementActionKind): boolean {
    const state = this.readState();
    const { session } = state;
    const batch = state.selectionCount > 1;
    switch (kind) {
      case "open-in":
        return batch || !state.worktreePath;
      case "copy-session-id":
        return batch || !session.sessionId;
      case "toggle-pin":
        return batch || session.isChild === true || session.archived;
      case "rename":
      case "set-icon":
      case "set-color":
      case "assign-owner":
        return batch;
      case "fork":
        return batch || state.forkDisabled;
      case "move-to-group":
      case "new-group":
        return session.isChild === true;
      case "toggle-archived":
        return !batch && !session.archived && !state.archiveAllowed;
      case "delete":
        return !state.deleteAllowed;
      case "toggle-unread":
        return false;
      default:
        return kind satisfies never;
    }
  }

  private runAction(action: SessionManagementAction): void {
    if (this.actionDisabled(action.kind, this.actionExtraDisabled(action.kind))) {
      return;
    }
    this.onClose();
    this.onAction(action);
  }

  handleSelect(value: string): boolean {
    if (
      value === "copy-session-id" ||
      value === "toggle-pin" ||
      value === "toggle-unread" ||
      value === "rename" ||
      value === "fork" ||
      value === "new-group" ||
      value === "toggle-archived" ||
      value === "delete"
    ) {
      this.runAction({ kind: value });
      return true;
    }
    if (value.startsWith("open-in:")) {
      const state = this.readState();
      const editor = EDITOR_IDS.find((candidate) => candidate === value.slice("open-in:".length));
      if (state.worktreePath && editor) {
        this.runAction({ kind: "open-in", editor, path: state.worktreePath });
      }
      return true;
    }
    if (value.startsWith("move-to-group:")) {
      const encodedCategory = value.slice("move-to-group:".length);
      this.runAction({
        kind: "move-to-group",
        category: encodedCategory ? decodeURIComponent(encodedCategory) : null,
      });
      return true;
    }
    if (value.startsWith("set-icon:")) {
      const encodedIcon = value.slice("set-icon:".length);
      this.runAction({
        kind: "set-icon",
        icon: encodedIcon ? decodeURIComponent(encodedIcon) : null,
      });
      return true;
    }
    if (value.startsWith("set-color:")) {
      const name = value.slice("set-color:".length);
      const color = normalizeSessionColorValue(name);
      if (!name || color) {
        this.runAction({ kind: "set-color", color });
      }
      return true;
    }
    const owner = sessionOwnerAssignmentFromMenuValue(value);
    if (owner) {
      this.runAction({ kind: "assign-owner", owner });
      return true;
    }
    return false;
  }

  prepareCompactView(view: CompactSessionMenuView): void {
    if (view === "icon") {
      this.iconPickerMode = "grid";
      this.customIconValue = "";
    }
  }

  handleKeydown(event: KeyboardEvent): boolean {
    const input = event
      .composedPath()
      .find(
        (target): target is HTMLInputElement =>
          target instanceof HTMLInputElement &&
          target.classList.contains("session-menu__icon-custom-input"),
      );
    if (!input) {
      return false;
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
    return true;
  }

  renderOpenInEntry(worktreePath: string | null) {
    const state = this.readState();
    if (state.compact) {
      return renderCompactSessionMenuNavigationItem({
        view: "open-in",
        label: t("sessionsView.openInEditorMenu"),
        icon: icons.externalLink,
        disabled: state.disabled || !worktreePath,
      });
    }
    return html`<wa-dropdown-item
      class="session-menu__item"
      ?disabled=${state.disabled || !worktreePath}
    >
      <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.externalLink}</span>
      <span class="session-menu__text">${t("sessionsView.openInEditorMenu")}</span>
      ${worktreePath ? this.renderEditorSubmenu() : nothing}
    </wa-dropdown-item>`;
  }

  renderPrimaryActions() {
    const state = this.readState();
    const { session } = state;
    const batch = state.selectionCount > 1;
    const count = String(state.selectionCount);
    const rootPlacementActions = session.isChild !== true;
    return html`
      ${batch || !rootPlacementActions
        ? nothing
        : html`<wa-dropdown-item
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
          </wa-dropdown-item>`}
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
            ${state.compact
              ? compactSessionOwnerOptions(state.ownerOptions, state.selfOwner).length > 0
                ? renderCompactSessionMenuNavigationItem({
                    view: "assign-owner",
                    label: t("sessionsView.assignTo"),
                    icon: icons.users,
                    disabled: this.actionDisabled("assign-owner"),
                    title: state.actionDisabledReasons["assign-owner"],
                  })
                : nothing
              : renderSessionOwnerAssignmentMenu({
                  ownerOptions: state.ownerOptions,
                  selfOwner: state.selfOwner,
                  currentOwnerId: state.currentOwnerId,
                  disabled: this.actionDisabled("assign-owner"),
                  disabledReason: state.actionDisabledReasons["assign-owner"],
                })}
            ${state.compact
              ? // One drill-down row for icon + color keeps the mobile More menu inside
                // its viewport height budget (mobile-chat-session-menu e2e).
                renderCompactSessionMenuNavigationItem({
                  view: "icon",
                  label: t("sessionsView.setIconColorMenu"),
                  icon: icons.star,
                  disabled: this.actionDisabled("set-icon"),
                  title: state.actionDisabledReasons["set-icon"],
                })
              : html`<wa-dropdown-item
                    class="session-menu__item"
                    data-shortcut="i"
                    aria-keyshortcuts="I"
                    ?disabled=${this.actionDisabled("set-icon")}
                    title=${this.actionTitle("set-icon")}
                    @submenu-opening=${this.focusIconGridOnOpen}
                  >
                    <span slot="icon" class="session-menu__icon" aria-hidden="true"
                      >${icons.star}</span
                    >
                    <span class="session-menu__text">${t("sessionsView.setIconMenu")}</span>
                    ${menuShortcutHint("i")} ${this.renderIconSubmenu()}
                  </wa-dropdown-item>
                  <wa-dropdown-item
                    class="session-menu__item"
                    ?disabled=${this.actionDisabled("set-color")}
                    title=${this.actionTitle("set-color")}
                  >
                    <span slot="icon" class="session-menu__icon" aria-hidden="true"
                      >${icons.palette}</span
                    >
                    <span class="session-menu__text">${t("sessionsView.setColorMenu")}</span>
                    ${this.renderColorSubmenu()}
                  </wa-dropdown-item>`}
            <wa-dropdown-item
              class="session-menu__item"
              value="fork"
              data-shortcut="f"
              aria-keyshortcuts="F"
              ?disabled=${this.actionDisabled("fork", state.forkDisabled)}
              title=${this.actionTitle("fork")}
            >
              <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.copy}</span>
              <span class="session-menu__text"
                >${t(
                  state.forkFromLastCompleted
                    ? "sessionsView.forkFromLastCompleted"
                    : "sessionsView.forkSession",
                )}</span
              >
              ${menuShortcutHint("f")}
            </wa-dropdown-item>
            <wa-dropdown-item
              class="session-menu__item"
              value="copy-session-id"
              data-shortcut="c"
              aria-keyshortcuts="C"
              ?disabled=${!session.sessionId}
            >
              <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.copy}</span>
              <span class="session-menu__text">${t("sessionsView.copySessionId")}</span>
              ${menuShortcutHint("c")}
            </wa-dropdown-item>
          `}
    `;
  }

  renderGroupAction() {
    const state = this.readState();
    const batch = state.selectionCount > 1;
    const count = String(state.selectionCount);
    if (state.session.isChild === true) {
      return nothing;
    }
    if (state.compact) {
      return renderCompactSessionMenuNavigationItem({
        view: "group",
        label: batch
          ? t("sessionsView.moveToGroupMenuCount", { count })
          : t("sessionsView.moveToGroupMenu"),
        icon: icons.folder,
        disabled: this.actionDisabled("move-to-group"),
        title: state.actionDisabledReasons["move-to-group"],
      });
    }
    return html`<wa-dropdown-item
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
    </wa-dropdown-item>`;
  }

  renderLifecycleActions() {
    const state = this.readState();
    const { session } = state;
    const batch = state.selectionCount > 1;
    const count = String(state.selectionCount);
    return html`
      <wa-dropdown-item
        class="session-menu__item"
        value="toggle-archived"
        data-shortcut="a"
        aria-keyshortcuts="A"
        ?disabled=${this.actionDisabled(
          "toggle-archived",
          !batch && !session.archived && !state.archiveAllowed,
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
        ?disabled=${this.actionDisabled("delete", !state.deleteAllowed)}
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
    `;
  }

  renderCompactView(view: CompactSessionMenuView) {
    const state = this.readState();
    return renderCompactSessionMenuView({
      view,
      ownerOptions: compactSessionOwnerOptions(state.ownerOptions, state.selfOwner),
      currentOwnerId: state.currentOwnerId,
      assignOwnerDisabled: this.actionDisabled("assign-owner"),
      assignOwnerDisabledReason: state.actionDisabledReasons["assign-owner"],
      renderOpenIn: () => this.renderEditorSubmenu(true),
      renderIcon: () =>
        html`${this.renderIconSubmenu(true)}
          <div class="session-menu__separator" role="separator"></div>
          ${this.renderColorSubmenu(true)}`,
      renderGroup: () => this.renderGroupSubmenu(true),
    });
  }

  private renderEditorSubmenu(inline = false) {
    return renderSessionEditorOptions({ inline, disabled: this.readState().disabled });
  }

  private renderGroupSubmenu(inline = false) {
    const state = this.readState();
    return renderSessionGroupOptions({
      inline,
      category: state.session.category,
      categoryClearReturnsToGroups: state.session.categoryClearReturnsToGroups,
      groups: state.groups,
      actionDisabled: (kind) => this.actionDisabled(kind),
      actionTitle: (kind) => this.actionTitle(kind),
    });
  }

  private renderColorSubmenu(inline = false) {
    return renderSessionColorOptions({
      inline,
      color: this.readState().session.color,
      disabled: this.actionDisabled("set-color"),
      disabledReason: this.readState().actionDisabledReasons["set-color"],
    });
  }

  private renderIconSubmenu(inline = false) {
    const state = this.readState();
    return renderSessionIconPicker({
      inline,
      mode: this.iconPickerMode,
      currentIcon: state.session.icon,
      customIconValue: this.customIconValue,
      disabled: this.actionDisabled("set-icon"),
      disabledReason: state.actionDisabledReasons["set-icon"],
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
    this.host.requestUpdate();
    void this.host.updateComplete.then(() => {
      this.host.querySelector<HTMLInputElement>(".session-menu__icon-custom-input")?.focus();
    });
  };

  private readonly showIconGrid = (event?: Event) => {
    event?.stopPropagation();
    this.iconPickerMode = "grid";
    this.customIconValue = "";
    this.host.requestUpdate();
    void this.host.updateComplete.then(() => {
      this.host.querySelector<HTMLButtonElement>(".session-menu__icon-choice--custom")?.focus();
    });
  };

  private readonly updateCustomIconValue = (event: InputEvent) => {
    if (event.currentTarget instanceof HTMLInputElement) {
      this.customIconValue = event.currentTarget.value;
      this.host.requestUpdate();
    }
  };

  private readonly applyCustomIcon = (event?: Event) => {
    event?.stopPropagation();
    const icon = normalizeSessionIconValue(this.customIconValue);
    if (icon) {
      this.runAction({ kind: "set-icon", icon });
    }
  };

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
    choice.tabIndex = -1;
    const next = choices[nextIndex];
    if (next) {
      next.tabIndex = 0;
      next.focus();
    }
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
    this.host.requestUpdate();
    void this.host.updateComplete.then(() =>
      requestAnimationFrame(() => {
        item.querySelector<HTMLButtonElement>('.session-menu__icon-choice[tabindex="0"]')?.focus();
      }),
    );
  };
}
