import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { beginNativeWindowDragFromTopInset } from "../app/native-window-drag.ts";
import { BoardAvailabilityController } from "../lib/board/availability-controller.ts";
import "./menu-surface.ts";
import "./session-menu.ts";
import "./sidebar-agent-card.ts";
import "./sidebar-attention.ts";
import "./sidebar-update-card.ts";
import "./theme-mode-toggle.ts";
import "./tooltip.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { createIdleImport } from "../lib/idle-import.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { sidebarPluginTabs } from "./app-sidebar-nav-menus.ts";
import {
  renderAppSidebarAttention,
  renderAppSidebarBrand,
  renderAppSidebarFooterBar,
  renderAppSidebarHomeRow,
  renderAppSidebarPagesHead,
  renderAppSidebarPluginTabEntry,
  renderAppSidebarZoneEntry,
} from "./app-sidebar-render.ts";
import type { CatalogSessionMenuRequest } from "./app-sidebar-session-catalogs.ts";
import { renderSessionList } from "./app-sidebar-session-list-render.ts";
import type {
  SidebarNarrationSyncInput,
  SidebarSessionNarrationController,
} from "./app-sidebar-session-narration.ts";
import { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import {
  renderSessionTree,
  type SessionListHost,
  visibleSessionChildren,
} from "./app-sidebar-session-row-render.ts";
import {
  loadStoredSidebarCatalogGrouping,
  storeSidebarCatalogGrouping,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import {
  lobsterPetSeed,
  resolveLobsterPetMode,
  resolveLobsterRunOutcome,
} from "./lobster-pet-contract.ts";
import { SessionOrganizerController } from "./session-organizer-controller.ts";
import { SidebarMenusController } from "./sidebar-menus-controller.ts";
// The shared loader retries transient chunk failures online; a deploy-pruned
// chunk still stays off until reload when that retry fails, by design.
const sidebarChromeImport = createIdleImport(() =>
  Promise.all([
    customElements.get("openclaw-lobster-pet") ? undefined : import("./lobster-pet.ts"),
    customElements.get("openclaw-viewer-facepile") ? undefined : import("./viewer-facepile.ts"),
  ]),
);

class AppSidebar extends AppSidebarSessionNavigationElement implements SessionListHost {
  @state() sidebarNarrationLines: ReadonlyMap<string, string> = new Map();
  @state() sidebarObserverDigests: ReadonlyMap<string, SessionObserverDigest> = new Map();

  override readonly sessionOrganizer = new SessionOrganizerController(this);
  override readonly sidebarMenus = new SidebarMenusController(this);

  // Lazy: the controller pulls core token-suppression modules that must stay
  // out of the startup chunk (QA smoke startup-JS budget). It loads on the
  // first update with the preference enabled; earlier events are safely
  // dropped because the controller aligns from cumulative snapshots.
  private narration: SidebarSessionNarrationController | null = null;
  private narrationLoad: Promise<void> | null = null;
  private readonly narrationSubscriptions = this.createNarrationSubscriptions();

  @state() protected catalogProjectGrouping = loadStoredSidebarCatalogGrouping();

  constructor() {
    super();
    void this.narrationSubscriptions;
    void new BoardAvailabilityController(
      this,
      () => {
        const mainKey = this.selectedAgentMainSessionKey(this.activeChipAgent().activeId);
        return [
          mainKey,
          ...this.visibleSessionRowsInOrder()
            .filter((session) => !session.isChild)
            .map((session) => session.key),
        ];
      },
      undefined,
      () => {
        const snapshot = this.context?.gateway.snapshot;
        const client = snapshot?.client;
        const availabilityClient =
          client &&
          typeof client.request === "function" &&
          typeof client.addEventListener === "function"
            ? client
            : null;
        return {
          client: availabilityClient,
          connected: snapshot?.phase === "connected",
          available: snapshot ? isGatewayMethodAdvertised(snapshot, "board.get") !== false : false,
          key: `${this.context?.gateway.connection?.gatewayUrl ?? ""}\u0000${
            snapshot?.hello?.server?.version ?? ""
          }`,
        };
      },
    );
  }

  private createNarrationSubscriptions(): SubscriptionsController {
    const subscriptions = new SubscriptionsController(this);
    subscriptions.effect(
      () => this.context?.gateway,
      (gateway) => gateway.subscribeEvents((event) => this.narration?.handleEvent(event)),
    );
    return subscriptions;
  }

  override disconnectedCallback() {
    this.narration?.disconnect();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    super.willUpdate(changed);
    // A fresh draft must be visible where it will live: genuinely expand a
    // collapsed Threads section (persisted) instead of overriding at render
    // time, so the header toggle keeps matching the visible state.
    if (
      changed.has("draftSessionAgentId") &&
      this.draftSessionAgentId &&
      this.collapsedSessionSections.has("ungrouped")
    ) {
      this.sessionOrganizer.toggleSection("ungrouped");
    }
  }

  override updated(changedProperties: PropertyValues<this>) {
    super.updated(changedProperties);
    if (!this.narration) {
      if (this.sidebarLiveActivity) {
        this.ensureNarrationController();
      }
      return;
    }
    this.narration.sync(this.narrationSyncInput());
  }

  private visibleNarrationRowsInOrder(): SidebarRecentSession[] {
    const rows: SidebarRecentSession[] = [];
    const append = (session: SidebarRecentSession) => {
      rows.push(session);
      if (this.isSessionChildrenExpanded(session)) {
        visibleSessionChildren({
          session,
          fullyShownChildSessionKeys: this.fullyShownChildSessionKeys,
        }).forEach(append);
      }
    };
    this.visibleSessionRowsInOrder().forEach(append);
    return rows;
  }

  private narrationSyncInput(): SidebarNarrationSyncInput {
    const gateway = this.context?.gateway.snapshot;
    return {
      enabled: this.sidebarLiveActivity,
      connected: this.connected && gateway?.phase === "connected",
      connectionIdentity: gateway?.client ?? null,
      source: this.context?.sessions ?? null,
      rows: this.visibleNarrationRowsInOrder(),
      openSessionKey: this.activeRouteId === "chat" ? this.getRouteSessionKey() : "",
      agentId: this.selectedAgentIdForSessions(),
    };
  }

  private ensureNarrationController(): void {
    if (this.narration || this.narrationLoad) {
      return;
    }
    this.narrationLoad = import("./app-sidebar-session-narration.ts").then((module) => {
      this.narrationLoad = null;
      // The element may have left the DOM while the chunk loaded.
      if (!this.isConnected) {
        return;
      }
      this.narration = new module.SidebarSessionNarrationController(
        (lines) => {
          this.sidebarNarrationLines = lines;
        },
        (digests) => {
          this.sidebarObserverDigests = digests;
        },
      );
      this.narration.sync(this.narrationSyncInput());
    });
  }

  override connectedCallback() {
    super.connectedCallback();
    // The decorative pet's large module stays out of startup and upgrades in place.
    // Its first visit is at least 15 seconds after load, so idle loading cannot miss one.
    sidebarChromeImport.schedule();
  }

  protected override firstUpdated() {
    requestAnimationFrame(() => requestAnimationFrame(() => this.classList.add("sidebar-r")));
  }

  startSessionDrag(session: SidebarRecentSession): void {
    this.sessionOrganizer.startSessionDrag(session);
  }

  finishSessionDrag(): void {
    this.sessionOrganizer.finishSessionDrag();
  }

  toggleSessionPin(session: SidebarRecentSession): void {
    void this.sessionOrganizer.patchSession(session, { pinned: !session.pinned });
  }

  toggleSessionMenu(
    session: SidebarRecentSession,
    menuSession: SidebarRecentSession,
    trigger: HTMLElement,
  ): void {
    if (this.sidebarMenus.sessionMenu?.session.key === session.key) {
      this.sidebarMenus.closeSessionMenu();
      return;
    }
    const rect = trigger.getBoundingClientRect();
    this.sidebarMenus.openSessionMenu(menuSession, rect.right, rect.bottom + 4, trigger);
  }

  startSessionGroupDrag(group: string): void {
    this.sessionOrganizer.startSessionGroupDrag(group);
  }

  finishSessionGroupDrag(): void {
    this.sessionOrganizer.finishSessionGroupDrag();
  }

  sectionDragOver(event: DragEvent, sectionId: string, group?: string): void {
    this.sessionOrganizer.sectionDragOver(event, sectionId, group);
  }

  sectionDragLeave(event: DragEvent, sectionId: string, group?: string): void {
    this.sessionOrganizer.sectionDragLeave(event, sectionId, group);
  }

  sectionDrop(event: DragEvent, sectionId: string, group?: string): void {
    this.sessionOrganizer.sectionDrop(event, sectionId, group);
  }

  toggleSection(sectionId: string): void {
    this.sessionOrganizer.toggleSection(sectionId);
  }

  handleSessionListDragOver(event: DragEvent): void {
    this.sessionOrganizer.handleSessionListDragOver(event);
  }

  handleSessionListDragLeave(event: DragEvent): void {
    this.sessionOrganizer.handleSessionListDragLeave(event);
  }

  handleSessionListDrop(event: DragEvent): void {
    this.sessionOrganizer.handleSessionListDrop(event);
  }

  openNewSession(): void {
    this.onOpenNewSession?.(this.expandedAgentId());
  }

  setVisibleSessionLimit(sectionId: string, limit: number): void {
    this.sessionData.setVisibleSessionLimit(sectionId, limit);
  }

  dismissSessionMutationError(): void {
    this.sessionData.dismissSessionMutationError();
  }

  toggleCatalogProjectGrouping(): void {
    const next = this.catalogProjectGrouping === "project" ? "none" : "project";
    storeSidebarCatalogGrouping(next);
    this.catalogProjectGrouping = next;
  }

  openCatalogMenu(
    request: CatalogSessionMenuRequest,
    x: number,
    y: number,
    trigger?: HTMLElement,
  ): void {
    this.sidebarMenus.catalogMenu.open(request, x, y, trigger);
  }

  renderPinnedSidebarSession(session: SidebarRecentSession): TemplateResult {
    return renderSessionTree({ host: this, session });
  }

  private renderSessions() {
    const navigationState = this.getSessionNavigationState();
    const visibleSessions = this.selectedAgentSessionRows(navigationState);
    const expandedAgentId = this.expandedAgentId();
    const liveRows = [
      ...(this.sessionData.sessionsResult?.sessions ?? []),
      ...Object.values(this.sessionData.sessionRowsByAgent).flat(),
    ];
    const sidebarRowsByKey = new Map<string, SidebarRecentSession>();
    for (const row of liveRows) {
      if (!sidebarRowsByKey.has(row.key)) {
        sidebarRowsByKey.set(row.key, navigationState.toSidebarSession(row));
      }
    }
    const { sections } = this.zonedVisibleSections(visibleSessions);
    return renderSessionList({
      host: this,
      empty: visibleSessions.length === 0,
      sections,
      showDraft:
        Boolean(this.draftSessionAgentId) &&
        normalizeAgentId(this.draftSessionAgentId) === expandedAgentId,
      catalogs: {
        catalogs: this.sessionData.sessionCatalogs,
        basePath: this.basePath,
        routeSessionKey: this.activeRouteId === "chat" ? this.getRouteSessionKey() : "",
        newSessionAgentId: expandedAgentId,
        loadingMoreCatalogIds: this.sessionData.loadingMoreSessionCatalogIds,
        projectGrouping: this.catalogProjectGrouping,
        liveRows,
        sidebarRowsByKey,
        creatorId: this.activeSessionCreatorId,
        catalogOpenTarget: this.catalogOpenTarget,
        terminalAvailable: this.terminalAvailable,
      },
    });
  }

  override render() {
    const sidebarZone = this.reconciledSidebarZone();
    return html`
      <aside class="sidebar">
        <div class="sidebar-shell" @mousedown=${beginNativeWindowDragFromTopInset}>
          ${renderAppSidebarBrand(this)}
          <div
            class="sidebar-shell__body sidebar-shell__body--scroll-${this.sessionData
              .sessionsScrollState}"
            @scroll=${(event: Event) =>
              this.sessionData.updateSessionsScrollState(event.currentTarget as HTMLElement)}
          >
            <nav class="sidebar-nav" @contextmenu=${this.sidebarMenus.openCustomizeMenuFromContext}>
              ${renderAppSidebarPagesHead(this)}
              <div
                class="nav-section__items"
                @dragover=${(event: DragEvent) =>
                  this.sessionOrganizer.handleSidebarZoneDragOver(event)}
                @dragleave=${(event: DragEvent) =>
                  this.sessionOrganizer.handleSidebarZoneDragLeave(event)}
                @drop=${(event: DragEvent) => this.sessionOrganizer.handleSidebarZoneDrop(event)}
              >
                ${renderAppSidebarHomeRow(this)}
                ${sidebarZone.entries.map((entry) =>
                  renderAppSidebarZoneEntry(
                    this,
                    entry,
                    sidebarZone.sessionRows,
                    sidebarZone.workboardRows,
                  ),
                )}
                ${sidebarPluginTabs(this.context?.gateway.snapshot.hello?.controlUiTabs).map(
                  (tab) => renderAppSidebarPluginTabEntry(this, tab),
                )}
              </div>
            </nav>
            ${this.renderSessions()}
          </div>
          <div class="sidebar-shell__footer">
            ${renderAppSidebarAttention(this)}
            <openclaw-sidebar-update-card
              .updateAvailable=${this.updateAvailable}
              .updateRunning=${this.updateRunning}
              .onUpdate=${this.onUpdate}
            ></openclaw-sidebar-update-card>
            <openclaw-lobster-pet
              .seed=${lobsterPetSeed(this.sessionKey)}
              .mode=${resolveLobsterPetMode(
                !this.offline,
                this.sessionData.sessionsResult?.sessions,
              )}
              .runOutcome=${resolveLobsterRunOutcome(this.sessionData.sessionsResult?.sessions)}
              .visitsEnabled=${this.lobsterPetVisits}
              .soundsEnabled=${this.lobsterPetSounds}
              .gatewayVersion=${this.gatewayVersion}
            ></openclaw-lobster-pet>
            ${this.devGitBranch
              ? html`<openclaw-tooltip .content=${this.devGitBranch}>
                  <div class="sidebar-footer-branch">
                    <span class="sidebar-footer-branch__icon" aria-hidden="true"
                      >${icons.gitBranch}</span
                    >
                    <span class="sidebar-footer-branch__name">${this.devGitBranch}</span>
                  </div>
                </openclaw-tooltip>`
              : nothing}
            ${renderAppSidebarFooterBar(this)}
          </div>
        </div>
        ${this.sidebarMenus.renderCustomizeMenu()} ${this.sidebarMenus.renderMoreMenu()}
        ${this.sidebarMenus.renderAgentMenu()} ${this.sidebarMenus.renderIdentityMenu()}
        ${this.sidebarMenus.renderSessionMenu()} ${this.sidebarMenus.catalogMenu.render()}
        ${this.sidebarMenus.renderSessionGroupMenu()} ${this.sidebarMenus.renderSessionSortMenu()}
      </aside>
    `;
  }
}

if (!customElements.get("openclaw-app-sidebar")) {
  customElements.define("openclaw-app-sidebar", AppSidebar);
}
