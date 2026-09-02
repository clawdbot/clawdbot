import { html, nothing, type ReactiveControllerHost, type TemplateResult } from "lit";
import { normalizeSessionIconValue } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { t } from "../i18n/index.ts";
import { EDITOR_IDS, type EditorId } from "../lib/editor-links.ts";
import { icons } from "./icons.ts";
import { menuShortcutHint } from "./menu-shortcuts.ts";
import { renderSessionAppearancePicker } from "./session-icon-picker.ts";
import {
  renderCompactSessionMenuNavigationItem,
  renderCompactSessionMenuView,
  type CompactSessionMenuView,
} from "./session-menu-compact.ts";
import { renderSessionEditorOptions, renderSessionGroupOptions } from "./session-menu-options.ts";
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
  | { kind: "copy-session-link" }
  | { kind: "copy-markdown" }
  | { kind: "open-new-tab" }
  | { kind: "open-new-window" }
  | { kind: "split-right" }
  | { kind: "split-below" }
  | { kind: "reset-appearance" }
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
  navigationAllowed: boolean;
  copyMarkdownAllowed: boolean;
  splitAllowed: boolean;
  renderOpenInExtra?: (inline: boolean) => TemplateResult;
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
      case "copy-session-link":
      case "open-new-tab":
      case "open-new-window":
        return batch || !state.navigationAllowed;
      case "copy-markdown":
        return batch || !state.copyMarkdownAllowed;
      case "split-right":
      case "split-below":
        return batch || !state.splitAllowed;
      case "reset-appearance":
        return batch || this.actionDisabled("set-icon") || this.actionDisabled("set-color");
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
    // Appearance edits share one persistent picker; all other actions dismiss it.
    if (
      action.kind !== "set-icon" &&
      action.kind !== "set-color" &&
      action.kind !== "reset-appearance"
    ) {
      this.onClose();
    }
    this.onAction(action);
  }

  handleSelect(value: string): boolean {
    if (
      value === "copy-session-id" ||
      value === "copy-session-link" ||
      value === "copy-markdown" ||
      value === "open-new-tab" ||
      value === "open-new-window" ||
      value === "split-right" ||
      value === "split-below" ||
      value === "reset-appearance" ||
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

  focusCurrentView(): void {
    void this.host.updateComplete.then(() => {
      const first =
        this.host.querySelector<HTMLElement>(".session-menu__appearance button:not(:disabled)") ??
        this.host.querySelector<HTMLElement>("wa-dropdown-item:not([disabled])");
      first?.focus();
    });
  }

  handleKeydown(event: KeyboardEvent): boolean {
    const target = event.composedPath().find((node) => node instanceof HTMLElement);
    const appearance = target?.closest<HTMLElement>(".session-menu__appearance");
    if (event.key === "Tab" && target && appearance && this.host.contains(appearance)) {
      const controls = Array.from(
        appearance.querySelectorAll<HTMLElement>(
          'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled)',
        ),
      );
      const index = controls.indexOf(target);
      const next = index < 0 ? undefined : controls[index + (event.shiftKey ? -1 : 1)];
      if (next) {
        // Web Awesome dismisses on Tab. The embedded picker owns internal
        // traversal; only its outer edges return to the menu's dismissal path.
        event.preventDefault();
        event.stopPropagation();
        next.focus();
        return true;
      }
      return false;
    }
    const input = event
      .composedPath()
      .find(
        (candidate): candidate is HTMLInputElement =>
          candidate instanceof HTMLInputElement &&
          candidate.classList.contains("session-menu__icon-custom-input"),
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

  private renderItem(
    kind: SessionManagementActionKind,
    label: string,
    icon: TemplateResult,
    options: { shortcut?: string; inline?: boolean; title?: string } = {},
  ) {
    return html`<wa-dropdown-item
      slot=${options.inline === false ? "submenu" : nothing}
      class=${`session-menu__item${kind === "delete" ? " session-menu__item--destructive" : ""}`}
      variant=${kind === "delete" ? "danger" : "neutral"}
      value=${kind}
      data-shortcut=${options.shortcut ?? nothing}
      aria-keyshortcuts=${options.shortcut?.toUpperCase() ?? nothing}
      ?data-new-tab-action=${kind === "open-new-tab" || kind === "open-new-window"}
      ?disabled=${this.actionDisabled(kind, this.actionExtraDisabled(kind))}
      title=${this.readState().actionDisabledReasons[kind] ?? options.title ?? nothing}
    >
      <span slot="icon" class="session-menu__icon" aria-hidden="true">${icon}</span>
      <span class="session-menu__text">${label}</span>
      ${options.shortcut ? menuShortcutHint(options.shortcut) : nothing}
    </wa-dropdown-item>`;
  }

  private renderSubmenu(
    view: Exclude<CompactSessionMenuView, "root">,
    label: string,
    icon: TemplateResult,
    body: () => TemplateResult,
    disabled = false,
  ) {
    if (this.readState().compact) {
      return renderCompactSessionMenuNavigationItem({ view, label, icon, disabled });
    }
    return html`<wa-dropdown-item
      class="session-menu__item"
      ?disabled=${disabled}
      data-shortcut=${view === "icon" ? "i" : view === "copy" ? "c" : nothing}
      aria-keyshortcuts=${view === "icon" ? "I" : view === "copy" ? "C" : nothing}
      @submenu-opening=${view === "icon" ? this.focusAppearanceOnOpen : nothing}
    >
      <span slot="icon" class="session-menu__icon" aria-hidden="true">${icon}</span>
      <span class="session-menu__text">${label}</span>
      ${view === "icon" ? menuShortcutHint("i") : view === "copy" ? menuShortcutHint("c") : nothing}
      ${body()}
    </wa-dropdown-item>`;
  }

  renderPrimaryActions() {
    const { session, selectionCount } = this.readState();
    const batch = selectionCount > 1;
    const count = String(selectionCount);
    return html`
      ${batch || session.isChild
        ? nothing
        : this.renderItem(
            "toggle-pin",
            t(session.pinned ? "sessionsView.unpinSession" : "sessionsView.pinSession"),
            session.pinned ? icons.pinOff : icons.pin,
            { shortcut: "p" },
          )}
      ${batch
        ? nothing
        : this.renderItem("rename", t("sessionsView.renameSessionMenu"), icons.edit, {
            shortcut: "r",
          })}
      ${this.renderItem(
        "toggle-unread",
        t(
          batch
            ? session.unread
              ? "sessionsView.markReadCount"
              : "sessionsView.markUnreadCount"
            : session.unread
              ? "sessionsView.markRead"
              : "sessionsView.markUnread",
          { count },
        ),
        session.unread ? icons.eye : icons.circle,
        { shortcut: "u" },
      )}
      ${this.renderItem(
        "toggle-archived",
        t(
          batch
            ? session.archived
              ? "sessionsView.restoreSessionCount"
              : "sessionsView.archiveSessionCount"
            : session.archived
              ? "sessionsView.restoreSession"
              : "sessionsView.archiveSession",
          { count },
        ),
        session.archived ? icons.archiveRestore : icons.archive,
        { shortcut: "a" },
      )}
    `;
  }

  renderOrganizationActions() {
    const state = this.readState();
    const batch = state.selectionCount > 1;
    return html`
      ${batch
        ? nothing
        : this.renderSubmenu(
            "icon",
            t("sessionsView.setIconColorMenu"),
            icons.palette,
            () => this.renderAppearancePicker(),
            this.actionDisabled("set-icon") && this.actionDisabled("set-color"),
          )}
      ${this.renderGroupAction()}
      ${batch
        ? nothing
        : state.compact
          ? state.selfOwner || state.ownerOptions.length > 0
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
    `;
  }

  renderTransferActions() {
    const state = this.readState();
    if (state.selectionCount > 1) {
      return nothing;
    }
    return html`
      ${this.renderItem("fork", t("sessionsView.forkSession"), icons.copy, {
        shortcut: "f",
        title: state.forkFromLastCompleted ? t("sessionsView.forkFromLastCompleted") : undefined,
      })}
      ${this.renderSubmenu("copy", t("common.copy"), icons.copy, () => this.renderCopySubmenu())}
      ${state.navigationAllowed || state.worktreePath || state.renderOpenInExtra
        ? this.renderSubmenu(
            "open-in",
            t("sessionsView.openInEditorMenu"),
            icons.externalLink,
            () => this.renderOpenSubmenu(),
          )
        : nothing}
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

  renderDeleteAction() {
    const state = this.readState();
    const label =
      state.selectionCount > 1
        ? t("sessionsView.deleteSessionCount", { count: String(state.selectionCount) })
        : t("sessionsView.deleteSessionMenu");
    return this.renderItem("delete", label, icons.trash, { shortcut: "d" });
  }

  renderCompactView(view: CompactSessionMenuView) {
    const state = this.readState();
    return renderCompactSessionMenuView({
      view,
      ownerOptions: state.ownerOptions,
      selfOwner: state.selfOwner,
      currentOwnerId: state.currentOwnerId,
      assignOwnerDisabled: this.actionDisabled("assign-owner"),
      assignOwnerDisabledReason: state.actionDisabledReasons["assign-owner"],
      renderOpenIn: () => this.renderOpenSubmenu(true),
      renderCopy: () => this.renderCopySubmenu(true),
      renderIcon: () => this.renderAppearancePicker(true),
      renderGroup: () => this.renderGroupSubmenu(true),
    });
  }

  private renderCopySubmenu(inline = false) {
    const state = this.readState();
    return html`
      ${state.navigationAllowed
        ? this.renderItem("copy-session-link", t("sessionsView.copySessionLink"), icons.link, {
            inline,
          })
        : nothing}
      ${this.renderItem("copy-markdown", t("sessionsView.copyMarkdown"), icons.fileText, {
        inline,
      })}
      ${this.renderItem("copy-session-id", t("sessionsView.copySessionId"), icons.copy, { inline })}
    `;
  }

  private renderOpenSubmenu(inline = false) {
    const state = this.readState();
    return html`
      ${state.navigationAllowed
        ? html`
            ${this.renderItem("open-new-tab", t("sessionsView.openNewTab"), icons.externalLink, {
              inline,
            })}
            ${this.renderItem("open-new-window", t("sessionsView.openNewWindow"), icons.monitor, {
              inline,
            })}
          `
        : nothing}
      ${state.splitAllowed
        ? html`
            ${this.renderItem("split-right", t("chat.splitView.splitRight"), icons.columns2, {
              inline,
            })}
            ${this.renderItem("split-below", t("sessionsView.splitBelow"), icons.panelBottomOpen, {
              inline,
            })}
          `
        : nothing}
      ${state.renderOpenInExtra?.(inline) ?? nothing}
      ${state.worktreePath
        ? html`
            <div slot=${inline ? nothing : "submenu"} class="session-menu__info">
              ${t("sessionsView.workspaceEditors")}
            </div>
            ${renderSessionEditorOptions({ inline, disabled: this.actionDisabled("open-in") })}
          `
        : nothing}
    `;
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

  private renderAppearancePicker(inline = false) {
    const state = this.readState();
    return renderSessionAppearancePicker({
      inline,
      mode: this.iconPickerMode,
      currentIcon: state.session.icon,
      currentColor: state.session.color,
      colorDisabled: this.actionDisabled("set-color"),
      colorDisabledReason: state.actionDisabledReasons["set-color"],
      onSelectColor: (event, color) => {
        event.stopPropagation();
        this.runAction({ kind: "set-color", color });
      },
      onReset: (event) => {
        event.stopPropagation();
        this.runAction({ kind: "reset-appearance" });
      },
      customIconValue: this.customIconValue,
      disabled: this.actionDisabled("set-icon"),
      disabledReason: state.actionDisabledReasons["set-icon"],
      onSelect: this.selectIcon,
      onShowCustom: this.showCustomIconEntry,
      onBack: this.showIconGrid,
      onInput: this.updateCustomIconValue,
      onApply: this.applyCustomIcon,
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
      const custom = this.host.querySelector<HTMLButtonElement>(
        ".session-menu__icon-choice--custom",
      );
      for (const choice of this.host.querySelectorAll<HTMLButtonElement>(
        ".session-menu__icon-choice",
      )) {
        choice.tabIndex = choice === custom ? 0 : -1;
      }
      custom?.focus();
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

  private readonly focusAppearanceOnOpen = (event: CustomEvent<{ item: HTMLElement }>) => {
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
        item
          .querySelector<HTMLButtonElement>(".session-menu__appearance button:not(:disabled)")
          ?.focus();
      }),
    );
  };
}
