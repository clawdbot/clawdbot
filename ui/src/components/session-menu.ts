import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { EDITOR_IDS, EDITOR_LABELS, type EditorId } from "../lib/editor-links.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import { activateMenuShortcut, menuShortcutHint } from "./menu-shortcuts.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";

export type SessionMenuData = {
  key: string;
  label: string;
  pinned: boolean;
  unread: boolean;
  archived: boolean;
  category: string | null;
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
  | { kind: "open-chat" }
  | { kind: "open-pr"; url: string }
  | { kind: "open-in"; editor: EditorId; path: string }
  | { kind: "toggle-pin" }
  | { kind: "toggle-unread" }
  | { kind: "rename" }
  | { kind: "fork" }
  | { kind: "workboard" }
  | { kind: "move-to-group"; category: string | null }
  | { kind: "new-group" }
  | { kind: "toggle-archived" }
  | { kind: "delete" };

const EMPTY_SESSION: SessionMenuData = {
  key: "",
  label: "",
  pinned: false,
  unread: false,
  archived: false,
  category: null,
};

class SessionMenu extends OpenClawLightDomElement {
  @property({ attribute: false }) session: SessionMenuData = EMPTY_SESSION;
  // >1 renders the batch menu: only actions that apply to every selected
  // session (unread/group/archive/delete); `session` then carries aggregated
  // flags (unread = all unread, category = shared category or null).
  @property({ attribute: false }) selectionCount = 1;
  @property({ attribute: false }) x = 0;
  @property({ attribute: false }) y = 0;
  @property({ attribute: false }) trigger: HTMLElement | null = null;
  @property({ attribute: false }) disabled = false;
  @property({ attribute: false }) forkDisabled = false;
  // Guards both Archive and Delete: hosts pass canArchiveSessionRow() so agent
  // main sessions and active runs stay protected from casual retirement.
  @property({ attribute: false }) archiveAllowed = false;
  @property({ attribute: false }) groups: readonly string[] = [];
  @property({ attribute: false }) canOpenChat = false;
  @property({ attribute: false }) work: SessionMenuWork | null = null;
  @property({ attribute: false }) workboard: { captured: boolean; busy: boolean } | null = null;
  @property({ attribute: false }) onAction: (action: SessionMenuAction) => void = () => {};
  @property({ attribute: false }) onClose: () => void = () => {};

  @state() private openSubmenu: "editor" | "group" | null = null;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    // Sidebar-hosted menus live inside the nav stacking context (z-index 10),
    // which paints below the sidebar resizer divider (z-index 20); promoting
    // the menu to the popover top layer keeps app chrome from bleeding
    // through it (same pattern as openclaw-native-link-menu).
    promoteToPopoverTopLayer(this);
  }

  override disconnectedCallback() {
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("session")) {
      const previous = changed.get("session") as SessionMenuData | undefined;
      if (previous?.key !== this.session.key) {
        this.openSubmenu = null;
      }
    }
  }

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has("session")) {
      const previous = changed.get("session") as SessionMenuData | undefined;
      if (previous?.key !== this.session.key) {
        this.querySelector<HTMLElement>(".session-menu__item")?.focus();
      }
    }
  }

  private readonly handleDocumentPointerDown = (event: PointerEvent) => {
    const path = event.composedPath();
    const menu = this.querySelector(".session-menu");
    if ((menu && path.includes(menu)) || (this.trigger && path.includes(this.trigger))) {
      return;
    }
    this.onClose();
  };

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      this.trigger?.focus();
      this.onClose();
      return;
    }
    activateMenuShortcut(this, event);
  };

  private runAction(action: SessionMenuAction) {
    this.onClose();
    this.onAction(action);
  }

  private renderWorkItems(submenuLeft: boolean) {
    const work = this.work;
    if (!work) {
      return nothing;
    }
    const pullRequestUrl = work.pullRequestUrl;
    const worktreePath = work.worktreePath;
    return html`
      <button
        type="button"
        class="session-menu__item"
        role="menuitem"
        data-shortcut="g"
        aria-keyshortcuts="G"
        ?disabled=${this.disabled || !pullRequestUrl}
        @click=${() => {
          if (pullRequestUrl) {
            this.runAction({ kind: "open-pr", url: pullRequestUrl });
          }
        }}
      >
        <span class="session-menu__icon" aria-hidden="true">${icons.gitPullRequest}</span>
        <span class="session-menu__text">${t("sessionsView.openPullRequest")}</span>
        ${menuShortcutHint("g")}
      </button>
      <div
        class="session-menu__submenu-host"
        @pointerenter=${() => {
          if (worktreePath) {
            this.openSubmenu = "editor";
          }
        }}
        @pointerleave=${() => {
          this.openSubmenu = null;
        }}
      >
        <button
          type="button"
          class="session-menu__item"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded=${String(this.openSubmenu === "editor")}
          ?disabled=${this.disabled || !worktreePath}
          @click=${() => {
            if (worktreePath) {
              this.openSubmenu = this.openSubmenu === "editor" ? null : "editor";
            }
          }}
        >
          <span class="session-menu__icon" aria-hidden="true">${icons.externalLink}</span>
          <span class="session-menu__text">${t("sessionsView.openInEditorMenu")}</span>
          <span class="session-menu__chevron" aria-hidden="true">${icons.chevronRight}</span>
        </button>
        ${this.openSubmenu === "editor" && worktreePath
          ? this.renderEditorSubmenu(worktreePath, submenuLeft)
          : nothing}
      </div>
      <div class="session-menu__separator" role="separator"></div>
    `;
  }

  private renderEditorSubmenu(path: string, submenuLeft: boolean) {
    return html`
      <div
        class="session-menu session-menu__submenu ${submenuLeft
          ? "session-menu__submenu--left"
          : ""}"
        role="menu"
        aria-label=${t("sessionsView.openInEditorMenu")}
      >
        ${EDITOR_IDS.map(
          (editor) => html`
            <button
              type="button"
              class="session-menu__item"
              role="menuitem"
              ?disabled=${this.disabled}
              @click=${() => this.runAction({ kind: "open-in", editor, path })}
            >
              <span class="session-menu__check" aria-hidden="true"></span>
              <span class="session-menu__text">${EDITOR_LABELS[editor]}</span>
            </button>
          `,
        )}
      </div>
    `;
  }

  private renderGroupSubmenu(submenuLeft: boolean) {
    const session = this.session;
    // Entries are numbered like the digits users see: existing groups first,
    // then the ungroup entry, then New group…; entries past 9 stay unnumbered
    // rather than reusing digits.
    let nextDigit = 1;
    const takeDigit = () => (nextDigit <= 9 ? String(nextDigit++) : null);
    const entry = (label: string, checked: boolean, action: SessionMenuAction) => {
      const digit = takeDigit();
      return html`
        <button
          type="button"
          class="session-menu__item"
          role="menuitem"
          data-shortcut=${digit ?? nothing}
          aria-keyshortcuts=${digit ?? nothing}
          ?disabled=${this.disabled}
          @click=${() => this.runAction(action)}
        >
          <span class="session-menu__check" aria-hidden="true"
            >${checked ? icons.check : nothing}</span
          >
          <span class="session-menu__text">${label}</span>
          ${digit ? menuShortcutHint(digit) : nothing}
        </button>
      `;
    };
    return html`
      <div
        class="session-menu session-menu__submenu ${submenuLeft
          ? "session-menu__submenu--left"
          : ""}"
        role="menu"
        aria-label=${t("sessionsView.moveToGroupMenu")}
      >
        ${this.groups.map((group) =>
          entry(group, session.category === group, { kind: "move-to-group", category: group }),
        )}
        ${session.category
          ? entry(t("sessionsView.removeFromGroup"), false, {
              kind: "move-to-group",
              category: null,
            })
          : nothing}
        ${this.groups.length > 0 || session.category
          ? html`<div class="session-menu__separator" role="separator"></div>`
          : nothing}
        ${entry(t("sessionsView.newGroup"), false, { kind: "new-group" })}
      </div>
    `;
  }

  override render() {
    const menuWidth = 240;
    const menuMaxHeight = 460;
    const clampedX = Math.max(8, Math.min(this.x, window.innerWidth - menuWidth - 8));
    const clampedY = Math.max(8, Math.min(this.y, window.innerHeight - menuMaxHeight - 8));
    const submenuLeft = clampedX + menuWidth * 2 + 4 > window.innerWidth - 8;
    const session = this.session;
    const batch = this.selectionCount > 1;
    const count = String(this.selectionCount);
    return html`
      <div
        class="session-menu"
        role="menu"
        aria-label=${batch
          ? t("chat.sidebar.sessionMenuMany", { count })
          : t("chat.sidebar.sessionMenu", { session: session.label })}
        style="left: ${clampedX}px; top: ${clampedY}px;"
      >
        ${!batch && this.canOpenChat
          ? html`
              <button
                type="button"
                class="session-menu__item"
                role="menuitem"
                data-shortcut="o"
                aria-keyshortcuts="O"
                ?disabled=${this.disabled}
                @click=${() => this.runAction({ kind: "open-chat" })}
              >
                <span class="session-menu__icon" aria-hidden="true">${icons.messageSquare}</span>
                <span class="session-menu__text">${t("sessionsView.openChat")}</span>
                ${menuShortcutHint("o")}
              </button>
            `
          : nothing}
        ${batch ? nothing : this.renderWorkItems(submenuLeft)}
        ${batch
          ? nothing
          : html`
              <button
                type="button"
                class="session-menu__item"
                role="menuitem"
                data-shortcut="p"
                aria-keyshortcuts="P"
                ?disabled=${this.disabled || session.archived}
                @click=${() => this.runAction({ kind: "toggle-pin" })}
              >
                <span class="session-menu__icon" aria-hidden="true"
                  >${session.pinned ? icons.pinOff : icons.pin}</span
                >
                <span class="session-menu__text"
                  >${session.pinned
                    ? t("sessionsView.unpinSession")
                    : t("sessionsView.pinSession")}</span
                >
                ${menuShortcutHint("p")}
              </button>
            `}
        <button
          type="button"
          class="session-menu__item"
          role="menuitem"
          data-shortcut="u"
          aria-keyshortcuts="U"
          ?disabled=${this.disabled}
          @click=${() => this.runAction({ kind: "toggle-unread" })}
        >
          <span class="session-menu__icon" aria-hidden="true"
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
        </button>
        ${batch
          ? nothing
          : html`
              <button
                type="button"
                class="session-menu__item"
                role="menuitem"
                data-shortcut="r"
                aria-keyshortcuts="R"
                ?disabled=${this.disabled}
                @click=${() => this.runAction({ kind: "rename" })}
              >
                <span class="session-menu__icon" aria-hidden="true">${icons.edit}</span>
                <span class="session-menu__text">${t("sessionsView.renameSessionMenu")}</span>
                ${menuShortcutHint("r")}
              </button>
              <button
                type="button"
                class="session-menu__item"
                role="menuitem"
                data-shortcut="f"
                aria-keyshortcuts="F"
                ?disabled=${this.disabled || this.forkDisabled}
                @click=${() => this.runAction({ kind: "fork" })}
              >
                <span class="session-menu__icon" aria-hidden="true">${icons.copy}</span>
                <span class="session-menu__text">${t("sessionsView.forkSession")}</span>
                ${menuShortcutHint("f")}
              </button>
            `}
        ${!batch && this.workboard
          ? html`
              <button
                type="button"
                class="session-menu__item"
                role="menuitem"
                data-shortcut="w"
                aria-keyshortcuts="W"
                ?disabled=${this.disabled || this.workboard.busy}
                @click=${() => this.runAction({ kind: "workboard" })}
              >
                <span class="session-menu__icon" aria-hidden="true"
                  >${this.workboard.captured ? icons.check : icons.plus}</span
                >
                <span class="session-menu__text"
                  >${this.workboard.captured
                    ? t("sessionsView.openWorkboardCard")
                    : t("sessionsView.addToWorkboard")}</span
                >
                ${menuShortcutHint("w")}
              </button>
            `
          : nothing}
        <div
          class="session-menu__submenu-host"
          @pointerenter=${() => {
            this.openSubmenu = "group";
          }}
          @pointerleave=${() => {
            this.openSubmenu = null;
          }}
        >
          <button
            type="button"
            class="session-menu__item"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded=${String(this.openSubmenu === "group")}
            ?disabled=${this.disabled}
            @click=${() => {
              this.openSubmenu = this.openSubmenu === "group" ? null : "group";
            }}
          >
            <span class="session-menu__icon" aria-hidden="true">${icons.folder}</span>
            <span class="session-menu__text"
              >${batch
                ? t("sessionsView.moveToGroupMenuCount", { count })
                : t("sessionsView.moveToGroupMenu")}</span
            >
            <span class="session-menu__chevron" aria-hidden="true">${icons.chevronRight}</span>
          </button>
          ${this.openSubmenu === "group" ? this.renderGroupSubmenu(submenuLeft) : nothing}
        </div>
        <div class="session-menu__separator" role="separator"></div>
        <button
          type="button"
          class="session-menu__item"
          role="menuitem"
          data-shortcut="a"
          aria-keyshortcuts="A"
          ?disabled=${this.disabled || (!session.archived && !this.archiveAllowed)}
          @click=${() => this.runAction({ kind: "toggle-archived" })}
        >
          <span class="session-menu__icon" aria-hidden="true"
            >${session.archived ? icons.archiveRestore : icons.archive}</span
          >
          <span class="session-menu__text"
            >${batch
              ? t("sessionsView.archiveSessionCount", { count })
              : session.archived
                ? t("sessionsView.restoreSession")
                : t("sessionsView.archiveSession")}</span
          >
          ${menuShortcutHint("a")}
        </button>
        <button
          type="button"
          class="session-menu__item session-menu__item--destructive"
          role="menuitem"
          data-shortcut="d"
          aria-keyshortcuts="D"
          ?disabled=${this.disabled || !(session.archived || this.archiveAllowed)}
          @click=${() => this.runAction({ kind: "delete" })}
        >
          <span class="session-menu__icon" aria-hidden="true">${icons.trash}</span>
          <span class="session-menu__text"
            >${batch
              ? t("sessionsView.deleteSessionCount", { count })
              : t("sessionsView.deleteSessionMenu")}</span
          >
          ${menuShortcutHint("d")}
        </button>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-session-menu")) {
  customElements.define("openclaw-session-menu", SessionMenu);
}
