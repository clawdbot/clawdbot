import { consume } from "@lit/context";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import "./openclaw-mascot.ts";
import type { RouteId } from "../app-route-paths.ts";
import { chatInputOwnerForContext } from "../app/chat-input-owner.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import {
  LazyCustomElementRequestController,
  isOptionalElementDefined,
} from "../app/lazy-custom-element.ts";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { t } from "../i18n/index.ts";
import { listSelectableAgents } from "../lib/agents/display.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  resolveUiConfiguredMainKey,
  resolveUiConversationIdentity,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import { buildHomeWorkContext, subscribeChatWorkContext } from "../pages/chat/chat-work-context.ts";
import {
  custodianSessionStore,
  type CustodianSessionStore,
} from "../pages/custodian/custodian-session-store.ts";
import { DockLayoutController } from "./dock-layout-controller.ts";
import { assistantPanelLayout, type DockPanelSide } from "./dock-panel-layout.ts";
import { icons } from "./icons.ts";
import { renderLazyElementState } from "./lazy-view-error.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT, HOME_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import "../pages/custodian/custodian-surface.ts";
import "../styles/assistant-panel.css";

const HOME_SESSION_ELEMENT = {
  tagName: "openclaw-home-session",
  get label() {
    return t("assistantPanel.home");
  },
  loadModule: () => import("./home-session.runtime.ts"),
};

type AssistantDestination = "home" | "custodian";
type AssistantDock = Exclude<DockPanelSide, "left">;

export class OpenClawAssistantPanel extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  @property({ attribute: false })
  context: ApplicationContext<RouteId> | undefined;
  @property({ type: Boolean }) custodianAvailable = false;
  @property({ type: Boolean }) homeAvailable = false;
  @property({ type: Boolean }) custodianSuppressed = false;
  @property() pageSessionKey = "";
  @property() pageAgentId = "";
  @property() pageRouteId: RouteId = "chat";
  @state() private destination: AssistantDestination = "custodian";
  private readonly homeLoader = new LazyCustomElementRequestController(this);
  @property({ type: Number }) minimizeRequestId = 0;
  @property({ attribute: false }) store: CustodianSessionStore = custodianSessionStore;

  private readonly dockLayout = new DockLayoutController(this, {
    layout: assistantPanelLayout,
    reservationPrefix: "assistant",
    isAvailable: () => this.available,
  });
  private readonly onToggleRequest = (event: Event) => this.handleToggleRequest(event);
  private handledMinimizeRequestId = 0;
  private targetScope = "";
  private homeDefaults: {
    agentsList?: ApplicationContext["agents"]["state"]["agentsList"];
    hello?: ApplicationContext["gateway"]["snapshot"]["hello"];
  } = {};
  private contextCleanup: (() => void) | null = null;
  private subscribedStore: CustodianSessionStore | null = null;
  private storeCleanup: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.subscribeToStore();
    window.addEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    window.addEventListener(HOME_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    this.dockLayout.setSuppressed(this.suppressed);
    this.refreshCustodianTranscript(this.dockLayout.open);
  }

  override disconnectedCallback(): void {
    window.removeEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    window.removeEventListener(HOME_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    this.claimInput("page");
    this.contextCleanup?.();
    this.contextCleanup = null;
    this.storeCleanup?.();
    this.storeCleanup = null;
    this.subscribedStore = null;
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues): void {
    const wasOpen = this.dockLayout.open;
    if (changed.has("context") && this.context) {
      this.contextCleanup?.();
      const cleanups = [
        subscribeChatWorkContext(this.context, () => this.requestUpdate()),
        // The sidebar switcher owns agent choice; the dock follows it.
        this.context.agentSelection.subscribe(() => this.requestUpdate()),
        // Snapshot changes need not change route facts; keep the open Home reference current.
        this.context.sessions.subscribe(() => this.requestUpdate()),
        this.context.agents.subscribe(() => this.requestUpdate()),
        this.context.gateway.subscribe(() => this.requestUpdate()),
      ];
      this.contextCleanup = () => {
        for (const cleanup of cleanups) {
          cleanup();
        }
      };
    }
    const scope = this.context?.gateway.connection.gatewayUrl ?? "";
    if (scope !== this.targetScope) {
      this.targetScope = scope;
      this.homeDefaults = {};
      let saved: Record<string, unknown> | null = null;
      try {
        saved = asNullableRecord(
          JSON.parse(getSafeLocalStorage()?.getItem(this.targetStorageKey) ?? "null"),
        );
      } catch {}
      this.destination = saved?.destination === "home" ? "home" : "custodian";
    }
    if (this.context?.gateway.snapshot.phase === "connected") {
      // Roster/hello disappear during reconnect; keep the captured Home identity with its outbox.
      this.homeDefaults = {
        agentsList: this.context.agents.state.agentsList ?? this.homeDefaults.agentsList,
        hello: this.context.gateway.snapshot.hello,
      };
    }
    if (changed.has("store")) {
      this.subscribeToStore();
    }
    this.dockLayout.setSuppressed(this.suppressed);
    if (
      this.minimizeRequestId > 0 &&
      this.minimizeRequestId !== this.handledMinimizeRequestId &&
      this.custodianAvailable
    ) {
      this.handledMinimizeRequestId = this.minimizeRequestId;
      if (this.store.hasRealUserTurn()) {
        this.openDestination("custodian");
      }
    }
    if (!this.available) {
      this.dockLayout.hideWithoutPersisting();
    } else {
      this.dockLayout.restoreOpenState();
    }
    this.refreshCustodianTranscript(!wasOpen && this.dockLayout.open);
    if (wasOpen && !this.dockLayout.open) {
      this.claimInput("page");
    }
    this.homeLoader.requestWhileActive(
      HOME_SESSION_ELEMENT,
      this.dockLayout.open && this.destination === "home",
    );
    this.dockLayout.syncReservation();
  }

  private get targetStorageKey(): string {
    return `openclaw.assistant.panel.target.v1:${this.targetScope}`;
  }

  private persistTarget(): void {
    try {
      getSafeLocalStorage()?.setItem(
        this.targetStorageKey,
        JSON.stringify({ destination: this.destination }),
      );
    } catch {}
  }

  private get homeTarget() {
    const defaults = this.homeDefaults;
    const agents = listSelectableAgents(defaults.agentsList?.agents ?? []);
    const defaultId = resolveUiDefaultAgentId(defaults);
    // The sidebar switcher (agentSelection) is the only agent chooser; the dock
    // shows the selected agent's Home and never grows a second switcher.
    const rawSelectedId = this.context?.agentSelection.state.selectedId;
    const selectedId = rawSelectedId ? normalizeAgentId(rawSelectedId) : "";
    const agentId =
      agents.find((agent) => agent.id === selectedId)?.id ??
      agents.find((agent) => agent.id === defaultId)?.id ??
      agents[0]?.id ??
      defaultId;
    return {
      ...resolveUiConversationIdentity(
        defaults,
        buildAgentMainSessionKey({ agentId, mainKey: resolveUiConfiguredMainKey(defaults) }),
        agentId,
      ),
      agentId,
    };
  }

  /** Ask OpenClaw hydrates lazily; only refresh when it actually becomes visible. */
  private refreshCustodianTranscript(becameVisible: boolean): void {
    if (becameVisible && this.destination === "custodian") {
      void this.store.refreshTranscriptIfIdle();
    }
  }

  private availableFor(destination: AssistantDestination): boolean {
    return destination === "home" ? this.homeAvailable : this.custodianAvailable;
  }

  private get available(): boolean {
    return this.availableFor(this.destination);
  }

  private get suppressed(): boolean {
    if (this.destination === "custodian") {
      return this.custodianSuppressed;
    }
    const context = this.context;
    if (!context || this.pageRouteId !== "chat") {
      return false;
    }
    const page = resolveUiConversationIdentity(
      this.homeDefaults,
      this.pageSessionKey,
      this.pageAgentId,
    );
    const home = this.homeTarget;
    return page.sessionKey === home.sessionKey && normalizeAgentId(page.agentId) === home.agentId;
  }

  private claimInput(region: "page" | "dock"): void {
    if (this.context) {
      chatInputOwnerForContext(this.context).claim(region);
    }
  }

  private openDestination(destination: AssistantDestination): void {
    this.destination = destination;
    this.dockLayout.setSuppressed(this.suppressed);
    if (this.available) {
      // Keep explicit open intent even when the same Home conversation owns the page.
      this.setOpen(true);
      if (this.suppressed) {
        this.dockLayout.hideWithoutPersisting();
        this.claimInput("page");
        if (destination === "home") {
          this.openHomePage();
        }
      }
    }
  }

  private subscribeToStore(): void {
    if (!this.isConnected || this.subscribedStore === this.store) {
      return;
    }
    this.storeCleanup?.();
    this.subscribedStore = this.store;
    this.storeCleanup = this.store.subscribe(() => this.requestUpdate());
  }

  private openHomePage(): void {
    if (this.context) {
      const { sessionKey, agentId } = this.homeTarget;
      const target = sessionNavigationTarget({
        context: this.context,
        face: "chat",
        sessionKey,
        agentId,
        focusComposer: true,
      });
      this.context.navigate("chat", target.options);
    }
  }

  private setDock(dock: AssistantDock): void {
    this.dockLayout.setDock(dock);
  }

  private setOpen(open: boolean): void {
    this.persistTarget();
    this.dockLayout.setOpen(open);
    this.claimInput(open ? "dock" : "page");
    this.refreshCustodianTranscript(open);
  }

  toggle(): void {
    if (!this.available) {
      return;
    }
    if (this.suppressed) {
      if (this.destination === "home") {
        this.openHomePage();
      }
      return;
    }
    this.setOpen(!this.dockLayout.open);
  }

  handleToggleRequest(event: Event): void {
    const destination = event.type === HOME_PANEL_TOGGLE_EVENT ? "home" : "custodian";
    if (!this.availableFor(destination)) {
      return;
    }
    const detail = asNullableRecord(event instanceof CustomEvent ? event.detail : null);
    const dock = detail?.dock;
    if (dock === "right" || dock === "bottom") {
      this.dockLayout.setDock(dock, false);
    }
    if (detail?.open === false) {
      if (this.destination === destination) {
        this.setOpen(false);
      }
    } else if (this.destination !== destination || detail?.open === true) {
      this.openDestination(destination);
    } else {
      this.toggle();
    }
  }

  get assistantPanelOpen(): boolean {
    return this.dockLayout.open;
  }

  override render() {
    if (!this.available || !this.dockLayout.open) {
      return nothing;
    }
    const dock = this.dockLayout.dock;
    const home = this.homeTarget;
    const homeState = this.homeLoader.visibleState;
    // The deferred panel owns preparation; the eager shell supplies route facts only.
    const workContext = this.context
      ? buildHomeWorkContext(this.context, this.pageRouteId, this.pageSessionKey, this.pageAgentId)
      : undefined;
    const style =
      dock === "bottom" ? `height:${this.dockLayout.height}px` : `width:${this.dockLayout.width}px`;
    return html`
      <section
        class="assistant-panel assistant-panel--${dock}"
        style=${style}
        aria-label=${t("assistantPanel.title")}
        @pointerdown=${() => this.claimInput("dock")}
        @focusin=${() => this.claimInput("dock")}
      >
        ${this.dockLayout.renderResizer("assistant-panel", t("assistantPanel.resize"))}
        <header class="rail-header assistant-panel-header" @mousedown=${beginNativeWindowDrag}>
          <div class="assistant-panel-title">
            <openclaw-mascot
              .mood=${this.destination === "custodian" && this.store.sending ? "thinking" : "idle"}
              .size=${16}
            ></openclaw-mascot>
            ${(["home", "custodian"] as const).map((destination) =>
              (destination === "home" ? this.homeAvailable : this.custodianAvailable)
                ? html`<button
                    type="button"
                    class="assistant-panel-tab"
                    aria-pressed=${this.destination === destination}
                    @click=${() => this.openDestination(destination)}
                  >
                    ${t(destination === "home" ? "assistantPanel.home" : "nav.askOpenClaw")}
                  </button>`
                : nothing,
            )}
          </div>
          <div class="rail-header__actions assistant-panel-actions">
            ${
              this.destination === "home"
                ? html`<button
                    class="rail-header__action assistant-panel-icon"
                    type="button"
                    aria-label=${t("assistantPanel.openHome")}
                    @click=${() => this.openHomePage()}
                  >
                    ${icons.maximize}
                  </button>`
                : nothing
            }
            <button
              class="rail-header__action assistant-panel-icon"
              type="button"
              aria-label=${
                dock === "bottom" ? t("assistantPanel.dockRight") : t("assistantPanel.dockBottom")
              }
              @click=${() => this.setDock(dock === "bottom" ? "right" : "bottom")}
            >
              ${dock === "bottom" ? icons.panelRightOpen : icons.panelBottomOpen}
            </button>
            <button
              class="rail-header__action assistant-panel-icon"
              type="button"
              aria-label=${t("assistantPanel.close")}
              @click=${() => this.setOpen(false)}
            >
              ${icons.x}
            </button>
          </div>
        </header>
        ${
          this.destination === "home"
            ? html`${
                isOptionalElementDefined(HOME_SESSION_ELEMENT)
                  ? html`<openclaw-home-session
                      .sessionKey=${home.sessionKey}
                      .agentId=${home.agentId}
                      .workContext=${workContext}
                    ></openclaw-home-session>`
                  : homeState
                    ? renderLazyElementState(
                        homeState,
                        () => this.homeLoader.retry(),
                        () => this.setOpen(false),
                      )
                    : nothing
              }`
            : html`<openclaw-custodian-surface
                .store=${this.store}
                .onboarding=${this.store.activeVariant === "onboarding"}
                .newAgentIntent=${this.store.activeVariant === "new-agent"}
                compact
              ></openclaw-custodian-surface>`
        }
      </section>
    `;
  }
}

if (!customElements.get("openclaw-assistant-panel")) {
  customElements.define("openclaw-assistant-panel", OpenClawAssistantPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-assistant-panel": OpenClawAssistantPanel;
  }
}
