import type { UiCommandParams } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient, GatewayEventFrame } from "../api/gateway.ts";
import type { GatewayAgentRow } from "../api/types.ts";
import type { RouteId } from "../app-routes.ts";
import type { SidebarWorkboardRuntime } from "../components/app-sidebar-workboard.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
  UI_COMMAND_EVENT,
} from "../components/panel-toggle-contract.ts";
import { i18n, isSupportedLocale } from "../i18n/index.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import type { ApplicationContext } from "./context.ts";
import {
  applyServerUiPrefs,
  flushServerUiPrefs,
  resetServerUiPrefsSync,
  resolveServerUiPrefState,
} from "./server-prefs.ts";

const AGENT_ROSTER_REFRESH_DEBOUNCE_MS = 100;

export type StoredOutboxScopeHost = {
  settings: { gatewayUrl?: string | null };
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; mainKey?: string | null } | null;
  hello?: { snapshot?: unknown } | null;
};

export type OutboxStoreRuntime = {
  summarizeStoredChatOutboxes: (state: StoredOutboxScopeHost) => {
    countsByScope: ReadonlyMap<string, number>;
    attentionCountsByScope: ReadonlyMap<string, number>;
    draftScopes: ReadonlySet<string>;
    total: number;
  };
  resolveStoredChatOutboxScope: (
    state: StoredOutboxScopeHost,
    sessionKey: string,
  ) => { sessionKey: string; agentId?: string };
  storedChatOutboxScopeKey: (scope: { sessionKey: string; agentId?: string }) => string;
  subscribeStoredChatOutboxChanges: (listener: () => void) => () => void;
};

export interface ShellGatewayHost {
  readonly context: ApplicationContext<RouteId> | undefined;
  routeState: ShellRouteState;
  activeSessionKey: string;
  desktopNavigationExpanded: boolean;
  agentsListClient: GatewayBrowserClient | null;
  agentsListSource: ApplicationContext["agents"] | null;
  sessionKeyClient: GatewayBrowserClient | null;
  runtimeConfigClient: GatewayBrowserClient | null;
  runtimeConfigSource: ApplicationContext["runtimeConfig"] | null;
  lastLocalePrefSignature: string | null;
  previousGatewayPhase: ApplicationContext["gateway"]["snapshot"]["phase"] | null;
  agentRosterRefreshTimer: ReturnType<typeof globalThis.setTimeout> | null;
  criticalNoticeRuntime: Promise<
    typeof import("../pages/chat/critical-observer-notice.runtime.ts")
  > | null;
  sidebarWorkboardRuntime: SidebarWorkboardRuntime | null;
  readonly outboxStoreImport: { load: () => Promise<unknown> };
  recoverDeletedActiveSession(sessionState: ApplicationContext["sessions"]["state"]): void;
  selectChatSession(sessionKey: string, agentId?: string | null): void;
  storedOutboxScopeHost(context: ApplicationContext<RouteId>): StoredOutboxScopeHost;
  syncSidebarWorkboard(): void;
  requestUpdate(): void;
}

function diffAgentRoster(
  previous: readonly GatewayAgentRow[],
  next: readonly GatewayAgentRow[],
): { invalidatedIds: string[]; changedIds: string[] } {
  const nextById = new Map(next.map((agent) => [agent.id, agent]));
  const invalidatedIds: string[] = [];
  const changedIds: string[] = [];
  for (const agent of previous) {
    const replacement = nextById.get(agent.id);
    if (!replacement) {
      invalidatedIds.push(agent.id);
    } else if (JSON.stringify(replacement) !== JSON.stringify(agent)) {
      invalidatedIds.push(agent.id);
      changedIds.push(agent.id);
    }
  }
  return { invalidatedIds, changedIds };
}

export class ShellGatewayOwner {
  constructor(private readonly host: ShellGatewayHost) {}

  reconcileServerUiPrefs(runtimeConfig: ApplicationContext["runtimeConfig"]): void {
    const snapshot = runtimeConfig.state.configSnapshot;
    const context = this.host.context;
    if (!snapshot?.config || !context || context.runtimeConfig !== runtimeConfig) {
      return;
    }
    const scope = context.gateway.connection.gatewayUrl;
    applyServerUiPrefs(snapshot.config, {
      scope,
      onThemeChanged: (theme) => context.theme.recordServerSelection(theme, scope),
      onApplied: (patch) => {
        if (patch.sidebarEntries !== undefined) {
          context.navigation.update({ sidebarEntries: patch.sidebarEntries });
        }
        context.theme.refresh();
      },
    });
    const localePref = resolveServerUiPrefState(snapshot.config, "locale", scope);
    const localePrefSignature = JSON.stringify([scope, localePref.overridden, localePref.value]);
    if (localePrefSignature === this.host.lastLocalePrefSignature) {
      return;
    }
    this.host.lastLocalePrefSignature = localePrefSignature;
    if (localePref.overridden && isSupportedLocale(localePref.value)) {
      void i18n.setLocale(localePref.value);
      return;
    }
    void i18n.useSystemLocale();
  }

  reconcileCommittedServerUiPrefs(
    runtimeConfig: ApplicationContext["runtimeConfig"],
    needsRefresh: boolean,
    retainedLocal = false,
  ): void {
    if (this.host.context?.runtimeConfig !== runtimeConfig) {
      return;
    }
    if (needsRefresh) {
      void runtimeConfig.refresh();
      return;
    }
    this.reconcileServerUiPrefs(runtimeConfig);
    if (retainedLocal) {
      this.host.context?.theme.refresh();
    }
  }

  handleGatewayEvent(event: GatewayEventFrame): void {
    this.host.sidebarWorkboardRuntime?.handleGatewayEvent(event.event);
    if (event.event === "sessions.changed") {
      const context = this.host.context;
      if (context) {
        this.host.recoverDeletedActiveSession(context.sessions.state);
      }
      return;
    }
    if (event.event === "session.observer") {
      const context = this.host.context;
      if (context) {
        // Recovery digests share the tracker so stale critical notices can announce again.
        this.host.criticalNoticeRuntime ??=
          import("../pages/chat/critical-observer-notice.runtime.ts");
        const payload = event.payload;
        void this.host.criticalNoticeRuntime.then((runtime) =>
          runtime.handleCriticalObserverDigest({
            payload,
            selectedSessionKey: this.host.activeSessionKey,
            sessionHost: this.host.storedOutboxScopeHost(context),
            sessions: context.sessions.state.result?.sessions ?? [],
            onOpen: (sessionKey, agentId) => this.host.selectChatSession(sessionKey, agentId),
          }),
        );
      }
      return;
    }
    if (event.event === "config.changed") {
      // A local settings draft owns config conflicts; external snapshots must not overwrite it.
      const runtimeConfig = this.host.context?.runtimeConfig;
      if (runtimeConfig && !runtimeConfig.state.configFormDirty) {
        void runtimeConfig.refresh();
      }
      this.scheduleAgentRosterRefresh();
      return;
    }
    if (event.event !== "ui.command" || !event.payload) {
      return;
    }
    const context = this.host.context;
    if (!context) {
      return;
    }
    const commandParams = event.payload as UiCommandParams;
    const { command } = commandParams;
    if (!command) {
      return;
    }
    if (command.kind === "sidebar") {
      this.host.desktopNavigationExpanded = false;
      context.navigation.update({ navCollapsed: !command.visible });
      return;
    }
    if (command.kind === "panel") {
      window.dispatchEvent(
        new CustomEvent(
          command.panel === "terminal" ? TERMINAL_PANEL_TOGGLE_EVENT : BROWSER_PANEL_TOGGLE_EVENT,
          {
            detail: {
              open: command.open,
              ...(command.dock ? { dock: command.dock } : {}),
              ...(command.panel === "terminal" && command.terminalSessionId
                ? { terminalSessionId: command.terminalSessionId }
                : {}),
            },
          },
        ),
      );
      return;
    }

    const handled = !window.dispatchEvent(
      new CustomEvent(UI_COMMAND_EVENT, { detail: commandParams, cancelable: true }),
    );
    if (!handled && (command.kind === "navigate" || command.kind === "split")) {
      this.host.selectChatSession(command.sessionKey);
    }
  }

  scheduleAgentRosterRefresh(): void {
    // Config writes arrive in bursts; only the final authoritative roster snapshot matters.
    if (this.host.agentRosterRefreshTimer !== null) {
      globalThis.clearTimeout(this.host.agentRosterRefreshTimer);
    }
    this.host.agentRosterRefreshTimer = globalThis.setTimeout(() => {
      this.host.agentRosterRefreshTimer = null;
      void this.refreshAgentRoster();
    }, AGENT_ROSTER_REFRESH_DEBOUNCE_MS);
  }

  async refreshAgentRoster(): Promise<void> {
    const context = this.host.context;
    if (!context) {
      return;
    }
    const previous = context.agents.state.agentsList;
    const activeAgentId = context.agentSelection.state.selectedId;
    const next = await context.agents.refreshList();
    if (!next || this.host.context !== context) {
      return;
    }
    const rosterDiff = diffAgentRoster(previous?.agents ?? [], next.agents);
    if (rosterDiff.invalidatedIds.length > 0) {
      context.agents.invalidateFiles(rosterDiff.invalidatedIds);
      context.agentIdentity.invalidate(rosterDiff.invalidatedIds);
    }
    if (rosterDiff.changedIds.length > 0) {
      void context.agentIdentity.ensure(rosterDiff.changedIds);
    }
    const nextIds = new Set(next.agents.map((agent) => agent.id));
    if (
      activeAgentId &&
      context.agentSelection.state.selectedId === activeAgentId &&
      next.agents.length > 0 &&
      !nextIds.has(activeAgentId)
    ) {
      context.agentSelection.set(next.defaultId);
    }
  }

  synchronizeGateway(snapshot: ApplicationContext["gateway"]["snapshot"]): void {
    const previousPhase = this.host.previousGatewayPhase;
    this.host.previousGatewayPhase = snapshot.phase;
    this.updateGatewaySessionKey(snapshot);
    this.ensureAgentsList(snapshot);
    this.ensureRuntimeConfig(snapshot);
    if (previousPhase !== "connected" && snapshot.phase === "connected") {
      i18n.retryPendingLocale();
    }
    this.host.syncSidebarWorkboard();
    // Gateway-served chunks retry on reconnect after an earlier idle import failed.
    if (snapshot.phase === "connected") {
      void this.host.outboxStoreImport.load().catch(() => undefined);
    }
  }

  ensureRuntimeConfig(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    runtimeConfig = this.host.context?.runtimeConfig,
  ): void {
    // Config-gated sidebar routes require the snapshot before any settings page opens.
    if (snapshot.phase !== "connected" || !snapshot.client || !runtimeConfig) {
      this.host.runtimeConfigClient = null;
      return;
    }
    if (
      this.host.runtimeConfigClient === snapshot.client &&
      this.host.runtimeConfigSource === runtimeConfig
    ) {
      return;
    }
    this.host.runtimeConfigClient = snapshot.client;
    this.host.runtimeConfigSource = runtimeConfig;
    flushServerUiPrefs(runtimeConfig, {
      afterCommit: ({ needsRefresh, retainedLocal }) =>
        this.reconcileCommittedServerUiPrefs(runtimeConfig, needsRefresh, retainedLocal),
    });
    void runtimeConfig.ensureLoaded();
  }

  ensureAgentsList(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    agents = this.host.context?.agents,
  ): void {
    if (snapshot.phase !== "connected" || !snapshot.client) {
      this.host.agentsListClient = null;
      return;
    }
    const routeId = this.host.routeState.routeId;
    if (!agents || !routeId || agents.state.agentsList) {
      return;
    }
    if (this.host.agentsListClient === snapshot.client && this.host.agentsListSource === agents) {
      return;
    }
    this.host.agentsListClient = snapshot.client;
    this.host.agentsListSource = agents;
    void agents.ensureList();
  }

  updateGatewaySessionKey(snapshot: {
    client: GatewayBrowserClient | null;
    sessionKey: string;
  }): void {
    const sessionKey = snapshot.sessionKey.trim();
    if (
      snapshot.client === this.host.sessionKeyClient &&
      sessionKey === this.host.activeSessionKey
    ) {
      return;
    }
    this.host.sessionKeyClient = snapshot.client;
    if (sessionKey) {
      this.host.activeSessionKey = sessionKey;
    }
  }

  reset(): void {
    void this.host.criticalNoticeRuntime?.then((runtime) => runtime.resetCriticalObserverTracker());
    this.host.agentsListClient = null;
    this.host.agentsListSource = null;
    this.host.sessionKeyClient = null;
    this.host.runtimeConfigClient = null;
    this.host.runtimeConfigSource = null;
    this.host.previousGatewayPhase = null;
    if (this.host.agentRosterRefreshTimer !== null) {
      globalThis.clearTimeout(this.host.agentRosterRefreshTimer);
      this.host.agentRosterRefreshTimer = null;
    }
    resetServerUiPrefsSync();
  }

  dispose(): void {
    this.host.lastLocalePrefSignature = null;
    this.reset();
  }
}
