import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { UiSettings } from "../../../app/settings.ts";
import { icons } from "../../../components/icons.ts";
import { activateMenuShortcut, menuShortcutHint } from "../../../components/menu-shortcuts.ts";
import type { SessionMenuActionKind } from "../../../components/session-menu.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import { EDITOR_IDS, EDITOR_LABELS, type EditorId } from "../../../lib/editor-links.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";

export type HeaderMenuAction =
  | { kind: "open-in"; editor: EditorId; path: string }
  | { kind: "rename" }
  | { kind: "fork" }
  | { kind: "toggle-archived" }
  | { kind: "delete" };

const EMPTY_SETTINGS = {} as UiSettings;

class ChatHeaderSessionMenu extends OpenClawLightDomElement {
  @property({ attribute: false }) sessionLabel = "";
  @property({ attribute: false }) worktreePath: string | null = null;
  @property({ attribute: false }) archived = false;
  @property({ attribute: false }) onboarding = false;
  @property({ attribute: false }) preferencesBrowserOnly = false;
  @property({ attribute: false }) settings: UiSettings = EMPTY_SETTINGS;
  @property({ attribute: false }) actionDisabledReasons: Partial<
    Record<SessionMenuActionKind, string>
  > = {};
  @property({ attribute: false }) forkDisabled = false;
  @property({ attribute: false }) archiveAllowed = false;
  @property({ attribute: false }) deleteAllowed = false;
  @property({ attribute: false }) onOpen: () => void = () => {};
  @property({ attribute: false }) onSettingsChange: (patch: Partial<UiSettings>) => void = () => {};
  @property({ attribute: false }) onAction: (action: HeaderMenuAction) => void = () => {};

  private actionDisabled(kind: SessionMenuActionKind, extra = false): boolean {
    return extra || Boolean(this.actionDisabledReasons[kind]);
  }

  private actionTitle(kind: SessionMenuActionKind): string | typeof nothing {
    return this.actionDisabledReasons[kind] ?? nothing;
  }

  private readonly handleSelect = (event: CustomEvent<{ item: { value?: string } }>) => {
    const value = event.detail.item.value;
    if (!value) {
      return;
    }
    if (value.startsWith("view:")) {
      event.preventDefault();
      if (this.onboarding) {
        return;
      }
      const setting = value.slice("view:".length);
      if (setting === "reasoning") {
        this.onSettingsChange({ chatShowThinking: !this.settings.chatShowThinking });
      } else if (setting === "tool-calls") {
        this.onSettingsChange({ chatShowToolCalls: !this.settings.chatShowToolCalls });
      } else if (setting === "commentary") {
        this.onSettingsChange({
          chatPersistCommentary: this.settings.chatPersistCommentary === false,
        });
      }
      return;
    }
    if (value.startsWith("open-in:") && this.worktreePath) {
      const editor = value.slice("open-in:".length) as EditorId;
      if (EDITOR_IDS.includes(editor)) {
        this.onAction({ kind: "open-in", editor, path: this.worktreePath });
      }
      return;
    }
    if (
      value === "rename" ||
      value === "fork" ||
      value === "toggle-archived" ||
      value === "delete"
    ) {
      if (!this.actionDisabled(value, value === "fork" && this.forkDisabled)) {
        this.onAction({ kind: value });
      }
    }
  };

  private renderEditorSubmenu() {
    return EDITOR_IDS.map(
      (editor) => html`
        <wa-dropdown-item slot="submenu" class="session-menu__item" value=${`open-in:${editor}`}>
          <span class="session-menu__text">${EDITOR_LABELS[editor]}</span>
        </wa-dropdown-item>
      `,
    );
  }

  private renderViewSubmenu() {
    const showThinking = this.onboarding ? false : this.settings.chatShowThinking;
    const showToolCalls = this.onboarding ? true : this.settings.chatShowToolCalls;
    const persistCommentary = this.settings.chatPersistCommentary !== false;
    const disabledTitle = this.onboarding ? t("chat.onboardingDisabled") : nothing;
    const item = (value: string, label: string, checked: boolean) => html`
      <wa-dropdown-item
        slot="submenu"
        class="session-menu__item"
        type="checkbox"
        value=${`view:${value}`}
        .checked=${checked}
        ?disabled=${this.onboarding}
        title=${disabledTitle}
      >
        <span class="session-menu__text">${label}</span>
      </wa-dropdown-item>
    `;
    return html`
      ${item("reasoning", t("chat.view.reasoning"), showThinking)}
      ${item("tool-calls", t("chat.view.toolCalls"), showToolCalls)}
      ${item("commentary", t("chat.view.commentary"), persistCommentary)}
      ${this.preferencesBrowserOnly
        ? html`<div slot="submenu" class="session-menu__info" role="note">
            ${t("quickSettings.personal.browserOnly")}
          </div>`
        : nothing}
    `;
  }

  override render() {
    const menuLabel = t("chat.sidebar.sessionMenu", { session: this.sessionLabel });
    return html`
      <wa-dropdown
        class="session-menu chat-header-session-menu"
        placement="bottom-end"
        aria-label=${menuLabel}
        @keydown=${(event: KeyboardEvent) => activateMenuShortcut(this, event)}
        @wa-show=${this.onOpen}
        @wa-select=${this.handleSelect}
      >
        <button
          slot="trigger"
          class="btn btn--ghost btn--icon chat-icon-btn chat-header-session-menu__trigger"
          type="button"
          aria-label=${menuLabel}
          aria-haspopup="menu"
        >
          ${icons.moreHorizontal}
        </button>
        ${this.worktreePath
          ? html`
              <wa-dropdown-item class="session-menu__item">
                <span slot="icon" class="session-menu__icon" aria-hidden="true"
                  >${icons.externalLink}</span
                >
                <span class="session-menu__text">${t("sessionsView.openInEditorMenu")}</span>
                ${this.renderEditorSubmenu()}
              </wa-dropdown-item>
              <div class="session-menu__separator" role="separator"></div>
            `
          : nothing}
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
        <wa-dropdown-item class="session-menu__item">
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.eye}</span>
          <span class="session-menu__text">${t("chat.view.menu")}</span>
          ${this.renderViewSubmenu()}
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
          <span class="session-menu__text">${t("sessionsView.forkSession")}</span>
          ${menuShortcutHint("f")}
        </wa-dropdown-item>
        <div class="session-menu__separator" role="separator"></div>
        <wa-dropdown-item
          class="session-menu__item"
          value="toggle-archived"
          data-shortcut="a"
          aria-keyshortcuts="A"
          ?disabled=${this.actionDisabled(
            "toggle-archived",
            !this.archived && !this.archiveAllowed,
          )}
          title=${this.actionTitle("toggle-archived")}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true"
            >${this.archived ? icons.archiveRestore : icons.archive}</span
          >
          <span class="session-menu__text"
            >${this.archived
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
          <span class="session-menu__text">${t("sessionsView.deleteSessionMenu")}</span>
          ${menuShortcutHint("d")}
        </wa-dropdown-item>
      </wa-dropdown>
    `;
  }
}

if (!customElements.get("openclaw-chat-header-session-menu")) {
  customElements.define("openclaw-chat-header-session-menu", ChatHeaderSessionMenu);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-header-session-menu": ChatHeaderSessionMenu;
  }
}
