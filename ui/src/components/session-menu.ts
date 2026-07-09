import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";

export type SessionMenuData = {
  key: string;
  label: string;
  pinned: boolean;
  unread: boolean;
  archived: boolean;
  category: string | null;
};

export type SessionMenuAction =
  | { kind: "open-chat" }
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
  @property({ attribute: false }) workboard: { captured: boolean; busy: boolean } | null = null;
  @property({ attribute: false }) onAction: (action: SessionMenuAction) => void = () => {};
  @property({ attribute: false }) onClose: () => void = () => {};

  @state() private submenuOpen = false;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
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
        this.submenuOpen = false;
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
    if (event.key !== "Escape") {
      return;
    }
    event.stopPropagation();
    this.trigger?.focus();
    this.onClose();
  };

  private runAction(action: SessionMenuAction) {
    this.onClose();
    this.onAction(action);
  }

  override render() {
    const menuWidth = 240;
    const menuMaxHeight = 460;
    const clampedX = Math.max(8, Math.min(this.x, window.innerWidth - menuWidth - 8));
    const clampedY = Math.max(8, Math.min(this.y, window.innerHeight - menuMaxHeight - 8));
    const submenuLeft = clampedX + menuWidth * 2 + 4 > window.innerWidth - 8;
    const session = this.session;
    return html`
      <div
        class="session-menu"
        role="menu"
        aria-label=${t("chat.sidebar.sessionMenu", { session: session.label })}
        style="left: ${clampedX}px; top: ${clampedY}px;"
      >
        ${this.canOpenChat
          ? html`
              <button
                type="button"
                class="session-menu__item"
                role="menuitem"
                ?disabled=${this.disabled}
                @click=${() => this.runAction({ kind: "open-chat" })}
              >
                <span class="session-menu__icon" aria-hidden="true">${icons.messageSquare}</span>
                <span class="session-menu__text">${t("sessionsView.openChat")}</span>
              </button>
            `
          : nothing}
        <button
          type="button"
          class="session-menu__item"
          role="menuitem"
          ?disabled=${this.disabled || session.archived}
          @click=${() => this.runAction({ kind: "toggle-pin" })}
        >
          <span class="session-menu__icon" aria-hidden="true"
            >${session.pinned ? icons.pinOff : icons.pin}</span
          >
          <span class="session-menu__text"
            >${session.pinned ? t("sessionsView.unpinSession") : t("sessionsView.pinSession")}</span
          >
        </button>
        <button
          type="button"
          class="session-menu__item"
          role="menuitem"
          ?disabled=${this.disabled}
          @click=${() => this.runAction({ kind: "toggle-unread" })}
        >
          <span class="session-menu__icon" aria-hidden="true"
            >${session.unread ? icons.eye : icons.circle}</span
          >
          <span class="session-menu__text"
            >${session.unread ? t("sessionsView.markRead") : t("sessionsView.markUnread")}</span
          >
        </button>
        <button
          type="button"
          class="session-menu__item"
          role="menuitem"
          ?disabled=${this.disabled}
          @click=${() => this.runAction({ kind: "rename" })}
        >
          <span class="session-menu__icon" aria-hidden="true">${icons.edit}</span>
          <span class="session-menu__text">${t("sessionsView.renameSessionMenu")}</span>
        </button>
        <button
          type="button"
          class="session-menu__item"
          role="menuitem"
          ?disabled=${this.disabled || this.forkDisabled}
          @click=${() => this.runAction({ kind: "fork" })}
        >
          <span class="session-menu__icon" aria-hidden="true">${icons.copy}</span>
          <span class="session-menu__text">${t("sessionsView.forkSession")}</span>
        </button>
        ${this.workboard
          ? html`
              <button
                type="button"
                class="session-menu__item"
                role="menuitem"
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
              </button>
            `
          : nothing}
        <div
          class="session-menu__submenu-host"
          @pointerenter=${() => {
            this.submenuOpen = true;
          }}
          @pointerleave=${() => {
            this.submenuOpen = false;
          }}
        >
          <button
            type="button"
            class="session-menu__item"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded=${String(this.submenuOpen)}
            ?disabled=${this.disabled}
            @click=${() => {
              this.submenuOpen = !this.submenuOpen;
            }}
          >
            <span class="session-menu__icon" aria-hidden="true">${icons.folder}</span>
            <span class="session-menu__text">${t("sessionsView.moveToGroupMenu")}</span>
            <span class="session-menu__chevron" aria-hidden="true">${icons.chevronRight}</span>
          </button>
          ${this.submenuOpen
            ? html`
                <div
                  class="session-menu session-menu__submenu ${submenuLeft
                    ? "session-menu__submenu--left"
                    : ""}"
                  role="menu"
                  aria-label=${t("sessionsView.moveToGroupMenu")}
                >
                  ${this.groups.map(
                    (group) => html`
                      <button
                        type="button"
                        class="session-menu__item"
                        role="menuitem"
                        ?disabled=${this.disabled}
                        @click=${() => this.runAction({ kind: "move-to-group", category: group })}
                      >
                        <span class="session-menu__check" aria-hidden="true"
                          >${session.category === group ? icons.check : nothing}</span
                        >
                        <span class="session-menu__text">${group}</span>
                      </button>
                    `,
                  )}
                  <button
                    type="button"
                    class="session-menu__item"
                    role="menuitem"
                    ?disabled=${this.disabled}
                    @click=${() => this.runAction({ kind: "new-group" })}
                  >
                    <span class="session-menu__check" aria-hidden="true"></span>
                    <span class="session-menu__text">${t("sessionsView.newGroup")}</span>
                  </button>
                  ${session.category
                    ? html`
                        <div class="session-menu__separator" role="separator"></div>
                        <button
                          type="button"
                          class="session-menu__item"
                          role="menuitem"
                          ?disabled=${this.disabled}
                          @click=${() => this.runAction({ kind: "move-to-group", category: null })}
                        >
                          <span class="session-menu__check" aria-hidden="true"></span>
                          <span class="session-menu__text"
                            >${t("sessionsView.removeFromGroup")}</span
                          >
                        </button>
                      `
                    : nothing}
                </div>
              `
            : nothing}
        </div>
        <div class="session-menu__separator" role="separator"></div>
        <button
          type="button"
          class="session-menu__item"
          role="menuitem"
          ?disabled=${this.disabled || (!session.archived && !this.archiveAllowed)}
          @click=${() => this.runAction({ kind: "toggle-archived" })}
        >
          <span class="session-menu__icon" aria-hidden="true"
            >${session.archived ? icons.archiveRestore : icons.archive}</span
          >
          <span class="session-menu__text"
            >${session.archived
              ? t("sessionsView.restoreSession")
              : t("sessionsView.archiveSession")}</span
          >
        </button>
        <button
          type="button"
          class="session-menu__item session-menu__item--destructive"
          role="menuitem"
          ?disabled=${this.disabled || !(session.archived || this.archiveAllowed)}
          @click=${() => this.runAction({ kind: "delete" })}
        >
          <span class="session-menu__icon" aria-hidden="true">${icons.trash}</span>
          <span class="session-menu__text">${t("sessionsView.deleteSessionMenu")}</span>
        </button>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-session-menu")) {
  customElements.define("openclaw-session-menu", SessionMenu);
}
