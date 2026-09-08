// Owns catalog-row menu state, actions, focus anchor, and rendering for AppSidebar.
import type { SessionsCatalogArchiveParams } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { CatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { openCatalogSessionInTerminal } from "../lib/sessions/catalog-terminal.ts";
import { showToast } from "../lib/toast.ts";
import type { CatalogSessionMenuRequest } from "./app-sidebar-session-catalogs.ts";
import type { SidebarSessionMutationScope } from "./app-sidebar-session-types.ts";
import "./catalog-session-menu.ts";
import type { CatalogSessionMenuAction } from "./catalog-session-menu.ts";
import { SESSION_MENU_OPEN_EVENT } from "./session-progress-hovercard-target.ts";

type SidebarCatalogSessionMenuState = CatalogSessionMenuRequest & { x: number; y: number };

export class SidebarCatalogMenuController {
  private state: SidebarCatalogSessionMenuState | null = null;
  private trigger: HTMLElement | null = null;

  constructor(
    private readonly hooks: {
      beforeOpen: () => void;
      requestUpdate: () => void;
      terminalAvailable: () => boolean;
      beginMutation: () => SidebarSessionMutationScope | null;
      isMutationCurrent: (scope: SidebarSessionMutationScope) => boolean;
      archive: (
        scope: SidebarSessionMutationScope,
        params: SessionsCatalogArchiveParams,
      ) => Promise<unknown>;
      afterDelete: (scope: SidebarSessionMutationScope, key: CatalogSessionKey) => Promise<void>;
      navigate: (request: Pick<CatalogSessionMenuRequest, "navigation" | "routeId">) => void;
    },
  ) {}

  get isOpen(): boolean {
    return this.state !== null;
  }

  isOpenFor(key: CatalogSessionKey): boolean {
    const openKey = this.state?.key;
    return (
      openKey?.catalogId === key.catalogId &&
      openKey.hostId === key.hostId &&
      openKey.threadId === key.threadId
    );
  }

  open(
    request: CatalogSessionMenuRequest,
    x: number,
    y: number,
    trigger: HTMLElement | null = null,
  ): void {
    trigger?.dispatchEvent(
      new CustomEvent(SESSION_MENU_OPEN_EVENT, { bubbles: true, composed: true }),
    );
    this.hooks.beforeOpen();
    this.trigger = trigger;
    this.state = { ...request, x, y };
    this.hooks.requestUpdate();
  }

  close(): void {
    if (!this.state && !this.trigger) {
      return;
    }
    this.trigger = null;
    this.state = null;
    this.hooks.requestUpdate();
  }

  retargetTrigger(key: CatalogSessionKey, element: Element | undefined): void {
    if (!(element instanceof HTMLElement) || !this.isOpenFor(key)) {
      return;
    }
    // Catalog adoption replaces the trigger while popup focus is elsewhere.
    queueMicrotask(() => {
      if (element.isConnected && !this.trigger?.isConnected && this.isOpenFor(key)) {
        this.trigger = element;
        this.hooks.requestUpdate();
      }
    });
  }

  private handleAction(
    menu: SidebarCatalogSessionMenuState,
    action: CatalogSessionMenuAction,
  ): void {
    if (action === "terminal") {
      if (menu.canOpenTerminal && this.hooks.terminalAvailable()) {
        openCatalogSessionInTerminal(menu.key, menu.agentId);
      }
      return;
    }
    if (action === "delete") {
      if (menu.canDelete) {
        void this.deleteSession(menu);
      }
      return;
    }
    this.hooks.navigate(menu);
  }

  private async deleteSession(menu: SidebarCatalogSessionMenuState): Promise<void> {
    const scope = this.hooks.beginMutation();
    if (!scope) {
      return;
    }
    try {
      const { showConfirmDialog } = await import("./confirm-dialog.ts");
      const confirmed = await showConfirmDialog({
        message: t("chat.catalog.deleteSessionConfirm"),
        details: menu.name,
        confirmLabel: t("chat.catalog.deleteSession"),
        danger: true,
        signal: scope.signal,
      });
      if (!this.hooks.isMutationCurrent(scope)) {
        showToast({
          message: t("sessionsView.deleteSessionStale", { session: menu.name }),
        });
        return;
      }
      if (!confirmed) {
        return;
      }
      await this.hooks.archive(scope, {
        ...menu.key,
        agentId: menu.agentId,
        confirmNoOtherRunner: true,
      });
      if (this.hooks.isMutationCurrent(scope)) {
        await this.hooks.afterDelete(scope, menu.key);
      }
    } catch (error) {
      showToast({ message: formatUiError(error) });
    }
  }

  render() {
    const menu = this.state;
    if (!menu) {
      return nothing;
    }
    return html`
      <openclaw-catalog-session-menu
        .x=${menu.x}
        .y=${menu.y}
        .trigger=${this.trigger}
        .lastActive=${menu.meta}
        .canDelete=${menu.canDelete}
        .terminalDisabled=${!menu.canOpenTerminal || !this.hooks.terminalAvailable()}
        .onAction=${(action: CatalogSessionMenuAction) => this.handleAction(menu, action)}
        .onClose=${() => this.close()}
      ></openclaw-catalog-session-menu>
    `;
  }
}
