import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { t } from "../i18n/index.ts";
import { EDITOR_IDS, EDITOR_LABELS, type EditorId } from "../lib/editor-links.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import { activateMenuShortcut, menuShortcutHint } from "./menu-shortcuts.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";
import { syncDropdownItemRadio } from "./web-awesome.ts";

type SessionMenuData = {
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
  | { kind: "stop-cloud-worker" }
  | { kind: "delete" };

const EMPTY_SESSION: SessionMenuData = {
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
  @property({ attribute: false }) anchor: { x: number; y: number } = { x: 0, y: 0 };
  @property({ attribute: false }) trigger: HTMLElement | null = null;
  @property({ attribute: false }) disabled = false;
  @property({ attribute: false }) forkDisabled = false;
  // Guards both Archive and Delete: hosts pass canArchiveSessionRow() so agent
  // main sessions and active runs stay protected from casual retirement.
  @property({ attribute: false }) archiveAllowed = false;
  @property({ attribute: false }) cloudWorkerStopAllowed = false;
  @property({ attribute: false }) groups: readonly string[] = [];
  @property({ attribute: false }) canOpenChat = false;
  @property({ attribute: false }) work: SessionMenuWork | null = null;
  @property({ attribute: false }) workboard: { captured: boolean; busy: boolean } | null = null;
  @property({ attribute: false }) onAction: (action: SessionMenuAction) => void = () => {};
  @property({ attribute: false }) onClose: () => void = () => {};

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    // Sidebar-hosted menus live inside the nav stacking context (z-index 10),
    // which paints below the sidebar resizer divider (z-index 20); promoting
    // the menu to the popover top layer keeps app chrome from bleeding
    // through it (same pattern as openclaw-native-link-menu).
    promoteToPopoverTopLayer(this);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
    super.disconnectedCallback();
  }

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
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

  private readonly handleSelect = (event: CustomEvent<{ item: { value?: string } }>) => {
    event.preventDefault();
    const value = event.detail.item.value;
    if (!value) {
      return;
    }
    const simpleActions: Partial<Record<string, SessionMenuAction>> = {
      "open-chat": { kind: "open-chat" },
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
    }
  };

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
          ?disabled=${this.disabled}
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
        ? entry(t("sessionsView.removeFromGroup"), false, "move-to-group:", false)
        : nothing}
      ${entry(t("sessionsView.newGroup"), false, "new-group", false)}
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
        ${!batch && this.canOpenChat
          ? html`
              <wa-dropdown-item
                class="session-menu__item"
                value="open-chat"
                data-shortcut="o"
                aria-keyshortcuts="O"
                ?disabled=${this.disabled}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true"
                  >${icons.messageSquare}</span
                >
                <span class="session-menu__text">${t("sessionsView.openChat")}</span>
                ${menuShortcutHint("o")}
              </wa-dropdown-item>
            `
          : nothing}
        ${batch ? nothing : this.renderWorkItems()}
        ${batch
          ? nothing
          : html`
              <wa-dropdown-item
                class="session-menu__item"
                value="toggle-pin"
                data-shortcut="p"
                aria-keyshortcuts="P"
                ?disabled=${this.disabled || session.archived}
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
          ?disabled=${this.disabled}
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
                ?disabled=${this.disabled}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.edit}</span>
                <span class="session-menu__text">${t("sessionsView.renameSessionMenu")}</span>
                ${menuShortcutHint("r")}
              </wa-dropdown-item>
              <wa-dropdown-item
                class="session-menu__item"
                value="fork"
                data-shortcut="f"
                aria-keyshortcuts="F"
                ?disabled=${this.disabled || this.forkDisabled}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.copy}</span>
                <span class="session-menu__text">${t("sessionsView.forkSession")}</span>
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
        <wa-dropdown-item class="session-menu__item" ?disabled=${this.disabled}>
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.folder}</span>
          <span class="session-menu__text"
            >${batch
              ? t("sessionsView.moveToGroupMenuCount", { count })
              : t("sessionsView.moveToGroupMenu")}</span
          >
          ${this.renderGroupSubmenu()}
        </wa-dropdown-item>
        <div class="session-menu__separator" role="separator"></div>
        ${!batch && this.cloudWorkerStopAllowed
          ? html`
              <wa-dropdown-item
                class="session-menu__item session-menu__item--destructive"
                value="stop-cloud-worker"
                variant="danger"
                ?disabled=${this.disabled}
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
          ?disabled=${this.disabled || (!session.archived && !this.archiveAllowed)}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true"
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
        </wa-dropdown-item>
        <wa-dropdown-item
          class="session-menu__item session-menu__item--destructive"
          value="delete"
          variant="danger"
          data-shortcut="d"
          aria-keyshortcuts="D"
          ?disabled=${this.disabled || !(session.archived || this.archiveAllowed)}
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
