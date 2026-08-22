import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { renderCopyButton } from "../../../components/copy-button.ts";
import { DropdownMenuController } from "../../../components/dropdown-menu-controller.ts";
import { icons } from "../../../components/icons.ts";
import { promoteToPopoverTopLayer } from "../../../components/menu-surface.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import { EDITOR_IDS, EDITOR_LABELS, type EditorId } from "../../../lib/editor-links.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";

export type SessionDiffScope =
  | { scope: "all" | "uncommitted" }
  | { scope: "commit"; commit: string };

type MenuAnchor = { x: number; y: number };

export type SessionDiffMenuData =
  | {
      kind: "file";
      anchor: MenuAnchor;
      trigger: HTMLElement;
      path: string;
      absolutePath?: string;
      canOpenFile: boolean;
      canReveal: boolean;
    }
  | {
      kind: "scope";
      anchor: MenuAnchor;
      trigger: HTMLElement;
      active: SessionDiffScope;
      result: SessionsDiffResult;
      placement?: "top-start" | "bottom-start";
    }
  | {
      kind: "sync";
      anchor: MenuAnchor;
      trigger: HTMLElement;
      command: string;
      root: string;
      branch: string;
    }
  | {
      kind: "view";
      anchor: MenuAnchor;
      trigger: HTMLElement;
      split: boolean;
      wrap: boolean;
    };

type WithoutMenuAnchor<T> = T extends unknown ? Omit<T, "anchor" | "trigger"> : never;
export type SessionDiffMenuDraft = WithoutMenuAnchor<SessionDiffMenuData>;

export type SessionDiffMenuAction =
  | { kind: "collapse-all" }
  | { kind: "copy-path"; path: string }
  | { kind: "expand-all" }
  | { kind: "open-editor"; editor: EditorId; path: string }
  | { kind: "open-file"; path: string }
  | { kind: "reveal-file"; path: string }
  | { kind: "scope"; value: SessionDiffScope }
  | { kind: "toggle-split" }
  | { kind: "toggle-wrap" };

class SessionDiffMenu extends OpenClawLightDomElement {
  @property({ attribute: false }) menu: SessionDiffMenuData | null = null;
  @property({ attribute: false }) onAction: (action: SessionDiffMenuAction) => void = () => {};
  @property({ attribute: false }) onClose: () => void = () => {};

  readonly menuLifecycle = new DropdownMenuController(this, {
    getTrigger: () => this.menu?.trigger ?? null,
    onClose: () => this.onClose(),
  });

  override connectedCallback() {
    super.connectedCallback();
    promoteToPopoverTopLayer(this);
  }

  private run(action: SessionDiffMenuAction) {
    this.onClose();
    this.onAction(action);
  }

  private readonly handleSelect = (event: CustomEvent<{ item: { value?: string } }>) => {
    event.preventDefault();
    const value = event.detail.item.value;
    if (!value) {
      return;
    }
    const simple: Record<string, SessionDiffMenuAction | undefined> = {
      "collapse-all": { kind: "collapse-all" },
      "expand-all": { kind: "expand-all" },
      "toggle-split": { kind: "toggle-split" },
      "toggle-wrap": { kind: "toggle-wrap" },
      "scope:all": { kind: "scope", value: { scope: "all" } },
      "scope:uncommitted": { kind: "scope", value: { scope: "uncommitted" } },
    };
    const fileMenu = this.menu?.kind === "file" ? this.menu : null;
    if (fileMenu && value === "copy-path") {
      this.run({ kind: "copy-path", path: fileMenu.path });
      return;
    }
    if (fileMenu && value === "open-file") {
      this.run({ kind: "open-file", path: fileMenu.path });
      return;
    }
    if (fileMenu && value === "reveal-file") {
      this.run({ kind: "reveal-file", path: fileMenu.path });
      return;
    }
    const action = simple[value];
    if (action) {
      this.run(action);
      return;
    }
    if (value.startsWith("open-editor:")) {
      const editor = value.slice("open-editor:".length) as EditorId;
      if (EDITOR_IDS.includes(editor)) {
        const path = this.menu?.kind === "file" ? this.menu.absolutePath : undefined;
        if (path) {
          this.run({ kind: "open-editor", editor, path });
        }
      }
      return;
    }
    if (value.startsWith("scope:commit:")) {
      this.run({
        kind: "scope",
        value: { scope: "commit", commit: value.slice("scope:commit:".length) },
      });
    }
  };

  private readonly handleAfterHide = (event: Event) => {
    if (event.currentTarget instanceof Node && event.currentTarget.isConnected) {
      this.onClose();
    }
  };

  private renderFileMenu(menu: Extract<SessionDiffMenuData, { kind: "file" }>) {
    return html`
      <wa-dropdown-item class="session-menu__item" value="copy-path">
        <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.copy}</span>
        <span class="session-menu__text">${t("chat.sessionDiff.copyPath")}</span>
      </wa-dropdown-item>
      <wa-dropdown-item class="session-menu__item" value="open-file" ?disabled=${!menu.canOpenFile}>
        <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.fileText}</span>
        <span class="session-menu__text">${t("chat.sessionDiff.openFile")}</span>
      </wa-dropdown-item>
      ${menu.canReveal
        ? html`<wa-dropdown-item class="session-menu__item" value="reveal-file">
            <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.folder}</span>
            <span class="session-menu__text">${t("chat.sessionDiff.revealInFileTree")}</span>
          </wa-dropdown-item>`
        : nothing}
      ${menu.absolutePath
        ? html`<wa-dropdown-item class="session-menu__item">
            <span slot="icon" class="session-menu__icon" aria-hidden="true"
              >${icons.externalLink}</span
            >
            <span class="session-menu__text">${t("chat.sessionDiff.openInEditor")}</span>
            ${EDITOR_IDS.map(
              (editor) => html`<wa-dropdown-item
                slot="submenu"
                class="session-menu__item"
                value=${`open-editor:${editor}`}
              >
                <span class="session-menu__text">${EDITOR_LABELS[editor]}</span>
              </wa-dropdown-item>`,
            )}
          </wa-dropdown-item>`
        : nothing}
    `;
  }

  private renderViewMenu(menu: Extract<SessionDiffMenuData, { kind: "view" }>) {
    return html`
      <wa-dropdown-item class="session-menu__item" value="collapse-all">
        <span class="session-menu__text">${t("chat.sessionDiff.collapseAll")}</span>
      </wa-dropdown-item>
      <wa-dropdown-item class="session-menu__item" value="expand-all">
        <span class="session-menu__text">${t("chat.sessionDiff.expandAll")}</span>
      </wa-dropdown-item>
      <div class="session-menu__separator" role="separator"></div>
      <wa-dropdown-item class="session-menu__item" value="toggle-wrap">
        <span class="session-menu__text"
          >${t(
            menu.wrap ? "chat.sessionDiff.disableWrapping" : "chat.sessionDiff.enableWrapping",
          )}</span
        >
      </wa-dropdown-item>
      <wa-dropdown-item class="session-menu__item" value="toggle-split">
        <span class="session-menu__text"
          >${t(
            menu.split ? "chat.sessionDiff.switchUnified" : "chat.sessionDiff.switchSplit",
          )}</span
        >
      </wa-dropdown-item>
    `;
  }

  private renderScopeMenu(menu: Extract<SessionDiffMenuData, { kind: "scope" }>) {
    const activeCommit = menu.active.scope === "commit" ? menu.active.commit : null;
    return html`
      ${this.renderScopeItem(
        "scope:all",
        t("chat.sessionDiff.allChanges"),
        menu.active.scope === "all",
      )}
      ${this.renderScopeItem(
        "scope:uncommitted",
        t("chat.sessionDiff.uncommitted"),
        menu.active.scope === "uncommitted",
      )}
      ${menu.result.commits?.length
        ? html`<div class="session-menu__separator" role="separator"></div>
            ${menu.result.commits.map((commit, index) =>
              this.renderScopeItem(
                `scope:commit:${commit.sha}`,
                html`<span class="session-diff-menu__sha">${commit.sha}</span>
                  <span class="session-diff-menu__subject">${commit.subject}</span>
                  ${index === 0
                    ? html`<span class="session-diff-menu__head"
                        >${t("chat.sessionDiff.head")}</span
                      >`
                    : nothing}`,
                activeCommit === commit.sha,
              ),
            )}`
        : nothing}
      ${menu.result.mergeBase
        ? html`<div class="session-menu__separator" role="separator"></div>
            <div class="session-diff-menu__merge-base">
              <span>${t("chat.sessionDiff.mergeBase")}</span>
              <span class="session-diff-menu__sha">${menu.result.mergeBase.sha}</span>
              <span class="session-diff-menu__subject">${menu.result.mergeBase.subject}</span>
            </div>`
        : nothing}
    `;
  }

  private renderScopeItem(value: string, label: unknown, checked: boolean) {
    return html`<wa-dropdown-item
      class="session-menu__item session-diff-menu__scope-item"
      value=${value}
      role="menuitemradio"
      aria-checked=${String(checked)}
    >
      <span class="session-menu__text">${label}</span>
      ${checked
        ? html`<span slot="details" class="session-menu__check" aria-hidden="true"
            >${icons.check}</span
          >`
        : nothing}
    </wa-dropdown-item>`;
  }

  private renderSyncMenu(menu: Extract<SessionDiffMenuData, { kind: "sync" }>) {
    return html`<div class="session-diff-menu__sync">
      <strong>${t("chat.sessionDiff.syncLocally")}</strong>
      <p>${t("chat.sessionDiff.syncDescription")}</p>
      ${this.renderCopyRow(menu.command, t("chat.sessionDiff.copyCommand"), true)}
      ${this.renderCopyRow(menu.root, t("chat.sessionDiff.checkoutPath"))}
      ${this.renderCopyRow(menu.branch, t("chat.sessionDiff.branchName"))}
      <p class="session-diff-menu__note">${t("chat.sessionDiff.uncommittedStay")}</p>
    </div>`;
  }

  private renderCopyRow(value: string, label: string, command = false) {
    return html`<div class="session-diff-menu__copy-row ${command ? "is-command" : ""}">
      <span class="session-diff-menu__copy-label">${label}</span>
      <code title=${value}>${value}</code>
      ${renderCopyButton(value, label)}
    </div>`;
  }

  override render() {
    const menu = this.menu;
    if (!menu) {
      return nothing;
    }
    const placement = menu.kind === "scope" ? (menu.placement ?? "top-start") : "bottom-end";
    const width = menu.kind === "sync" ? 360 : menu.kind === "scope" ? 340 : 240;
    const menuLabel =
      menu.kind === "file"
        ? t("chat.sessionDiff.fileActions", { path: menu.path })
        : menu.kind === "scope"
          ? t("chat.sessionDiff.scopeMenu")
          : menu.kind === "sync"
            ? t("chat.sessionDiff.syncLocally")
            : t("chat.sessionDiff.viewOptions");
    const clampedX = Math.max(8, Math.min(menu.anchor.x, window.innerWidth - 8));
    const clampedY = Math.max(8, Math.min(menu.anchor.y, window.innerHeight - 8));
    return html`<wa-dropdown
      class="session-menu session-diff-menu session-diff-menu--${menu.kind}"
      style=${`--session-diff-menu-width:${width}px`}
      .open=${true}
      placement=${placement}
      .distance=${4}
      aria-label=${menuLabel}
      @wa-select=${this.handleSelect}
      @wa-after-hide=${this.handleAfterHide}
    >
      <button
        slot="trigger"
        type="button"
        tabindex="-1"
        aria-hidden="true"
        style="position:fixed;left:${clampedX}px;top:${clampedY}px;width:1px;height:1px;opacity:0;pointer-events:none"
      ></button>
      ${menu.kind === "file"
        ? this.renderFileMenu(menu)
        : menu.kind === "scope"
          ? this.renderScopeMenu(menu)
          : menu.kind === "sync"
            ? this.renderSyncMenu(menu)
            : this.renderViewMenu(menu)}
    </wa-dropdown>`;
  }
}

if (!customElements.get("openclaw-session-diff-menu")) {
  customElements.define("openclaw-session-diff-menu", SessionDiffMenu);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-diff-menu": SessionDiffMenu;
  }
}
