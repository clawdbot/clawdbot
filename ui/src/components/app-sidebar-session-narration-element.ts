import { state } from "lit/decorators.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { AppSidebarMenusElement } from "./app-sidebar-menus.ts";
import type {
  SidebarNarrationSyncInput,
  SidebarSessionNarrationController,
} from "./app-sidebar-session-narration.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

/** Gateway subscription and reactive narration state for the session-list renderer. */
export abstract class AppSidebarSessionNarrationElement extends AppSidebarMenusElement {
  @state() protected sidebarNarrationLines: ReadonlyMap<string, string> = new Map();
  @state() protected sidebarObserverDigests: ReadonlyMap<string, SessionObserverDigest> = new Map();

  // Lazy: the controller pulls core token-suppression modules that must stay
  // out of the startup chunk (QA smoke startup-JS budget). It loads on the
  // first update with the preference enabled; earlier events are safely
  // dropped because the controller aligns from cumulative snapshots.
  private narration: SidebarSessionNarrationController | null = null;
  private narrationLoad: Promise<void> | null = null;
  private readonly narrationSubscriptions = new SubscriptionsController(this);

  protected abstract visibleSessionChildren(
    session: SidebarRecentSession,
  ): readonly SidebarRecentSession[];

  private visibleNarrationRowsInOrder(): SidebarRecentSession[] {
    const rows: SidebarRecentSession[] = [];
    const append = (session: SidebarRecentSession) => {
      rows.push(session);
      if (this.isSessionChildrenExpanded(session)) {
        this.visibleSessionChildren(session).forEach(append);
      }
    };
    this.visibleSessionRowsInOrder().forEach(append);
    return rows;
  }

  constructor() {
    super();
    this.narrationSubscriptions.effect(
      () => this.context?.gateway,
      (gateway) => gateway.subscribeEvents((event) => this.narration?.handleEvent(event)),
    );
  }

  override disconnectedCallback() {
    this.narration?.disconnect();
    super.disconnectedCallback();
  }

  private narrationSyncInput(): SidebarNarrationSyncInput {
    const gateway = this.context?.gateway.snapshot;
    return {
      enabled: this.sidebarLiveActivity,
      connected: this.connected && gateway?.connected === true,
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

  override updated() {
    super.updated();
    if (!this.narration) {
      if (this.sidebarLiveActivity) {
        this.ensureNarrationController();
      }
      return;
    }
    this.narration.sync(this.narrationSyncInput());
  }
}
