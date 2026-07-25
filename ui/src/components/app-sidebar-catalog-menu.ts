// Owns catalog-row menu state, actions, focus anchor, and rendering for AppSidebar.
import { html, nothing } from "lit";
import { openCatalogSessionInTerminal } from "../lib/sessions/catalog-terminal.ts";
import type { CatalogSessionMenuRequest } from "./app-sidebar-session-catalogs.ts";
import "./catalog-session-menu.ts";
import type { CatalogSessionMenuAction } from "./catalog-session-menu.ts";

type SidebarCatalogSessionMenuState = CatalogSessionMenuRequest & { x: number; y: number };

export class SidebarCatalogMenuController {
  private state: SidebarCatalogSessionMenuState | null = null;
  private trigger: HTMLElement | null = null;

  constructor(
    private readonly hooks: {
      beforeOpen: () => void;
      requestUpdate: () => void;
      terminalAvailable: () => boolean;
      navigate: (search: string) => void;
    },
  ) {}

  get isOpen(): boolean {
    return this.state !== null;
  }

  open(
    request: CatalogSessionMenuRequest,
    x: number,
    y: number,
    trigger: HTMLElement | null = null,
  ): void {
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

  private handleAction(
    menu: SidebarCatalogSessionMenuState,
    action: CatalogSessionMenuAction,
  ): void {
    if (action === "terminal") {
      if (menu.canOpenTerminal && this.hooks.terminalAvailable()) {
        openCatalogSessionInTerminal(menu.key);
      }
      return;
    }
    this.hooks.navigate(menu.search);
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
        .terminalDisabled=${!menu.canOpenTerminal || !this.hooks.terminalAvailable()}
        .onAction=${(action: CatalogSessionMenuAction) => this.handleAction(menu, action)}
        .onClose=${() => this.close()}
      ></openclaw-catalog-session-menu>
    `;
  }
}
