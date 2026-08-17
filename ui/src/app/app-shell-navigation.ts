import { isSettingsNavigationRoute } from "../app-navigation.ts";
import { isSessionRouteId } from "../app-route-paths.ts";
import { isRouteId, type RouteId } from "../app-routes.ts";
import type { BoardFace } from "../lib/board/settings.ts";
import {
  findUiSessionRow,
  resolveSessionNavigationAgentId,
  resolveSessionPreferredFaceForKey,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  uiSessionEventMatches,
} from "../lib/sessions/session-key.ts";
import {
  deleteStoredChatSnapshot,
  resolveChatSnapshotKey,
} from "../pages/chat/session-snapshot-invalidation.ts";
import { newSessionSearch, type NewSessionTarget } from "../pages/new-session/location.ts";
import { selectApplicationSession } from "./agent-selection.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "./context.ts";
import { considerRouteRestore, persistRoute } from "./native-route-memory.ts";

export interface ShellNavigationHost {
  readonly context: ApplicationContext<RouteId> | undefined;
  activeSessionKey: string;
  routeState: ShellRouteState;
  lastWorkspaceLocation: { routeId: RouteId; pathname: string; search: string } | null;
  custodianMinimizeRequestId: number;
  lastConcreteRouteId: RouteId | undefined;
  didConsiderNativeRouteRestore: boolean;
  settingsSearchQuery: string;
  closeNavDrawer(options?: { restoreFocus?: boolean }): void;
  ensureAgentsList(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    agents?: ApplicationContext["agents"],
  ): void;
}

export class ShellNavigationOwner {
  constructor(private readonly host: ShellNavigationHost) {}

  selectChatSession(sessionKey: string, agentId?: string | null): void {
    const context = this.host.context;
    if (!context) {
      return;
    }
    selectApplicationSession({
      selection: context.agentSelection,
      gateway: context.gateway,
      sessionKey,
      agentId,
    });
    const face = resolveSessionPreferredFaceForKey(context, sessionKey, agentId);
    this.navigate(
      face,
      sessionNavigationTarget({
        context,
        face,
        sessionKey,
        ...(agentId ? { agentId } : {}),
        preferenceDerivedFace: true,
      }).options,
    );
  }

  chatNavigationOptions(face: BoardFace, options?: ApplicationNavigationOptions) {
    const sessionKey = this.host.activeSessionKey.trim();
    const context = this.host.context;
    return (
      options ??
      (sessionKey && context
        ? sessionNavigationTarget({ context, face, sessionKey }).options
        : undefined)
    );
  }

  navigate(routeId: string, options?: ApplicationNavigationOptions): void {
    const context = this.host.context;
    if (!context || !isRouteId(routeId)) {
      return;
    }
    this.host.closeNavDrawer({ restoreFocus: true });
    context.navigate(
      routeId,
      isSessionRouteId(routeId) ? this.chatNavigationOptions(routeId, options) : options,
    );
  }

  replaceChatWithCurrentSession(): boolean {
    const context = this.host.context;
    const sessionKey = this.host.activeSessionKey.trim();
    if (!context) {
      return true;
    }
    if (!parseAgentSessionKey(sessionKey) && context.gateway.snapshot.phase !== "connected") {
      return false;
    }
    const face = this.host.routeState.routeId === "dashboard" ? "dashboard" : "chat";
    const sessionWasDeleted = (context.sessions.state.deletedSessions ?? []).some(
      ({ key, agentId }) =>
        uiSessionEventMatches(
          {
            agentsList: context.agents.state.agentsList,
            hello: context.gateway.snapshot.hello,
            sessionKey,
          },
          key,
          agentId,
        ),
    );
    // Session lists are filtered and windowed. Only a failed route for this
    // active key, or an authoritative deletion, proves it needs replacement.
    const activeSessionRow = findUiSessionRow(context, sessionKey);
    const attemptedPathname = this.host.routeState.location?.pathname;
    const activeRouteFailed =
      !attemptedPathname ||
      attemptedPathname === sessionNavigationTarget({ context, face, sessionKey }).options.pathname;
    const parsedAgentId = parseAgentSessionKey(sessionKey)?.agentId;
    const knownAgents = context.agents.state.agentsList?.agents;
    // A parseable retired agent is not a navigable owner; never turn its
    // deleted session into another permanently unresolvable chat route.
    const replacementAgentId =
      parsedAgentId &&
      (!knownAgents || knownAgents.some((agent) => normalizeAgentId(agent.id) === parsedAgentId))
        ? parsedAgentId
        : resolveSessionNavigationAgentId(context);
    const replacementSessionKey =
      !sessionWasDeleted && (activeSessionRow?.key || !activeRouteFailed)
        ? sessionKey
        : buildAgentMainSessionKey({
            agentId: replacementAgentId,
            mainKey: resolveUiConfiguredMainKey({
              agentsList: context.agents.state.agentsList,
              hello: context.gateway.snapshot.hello,
            }),
          });
    // Gateway rejects deletion of a live main session. If an orphaned event
    // still names that fallback, replacing the same route would retry forever.
    if (sessionWasDeleted && replacementSessionKey === sessionKey) {
      return true;
    }
    if (replacementSessionKey !== sessionKey) {
      // Commit the replacement to both selection owners before navigating;
      // otherwise a stale Gateway snapshot restores the deleted key and loops.
      this.host.activeSessionKey = replacementSessionKey;
      selectApplicationSession({
        selection: context.agentSelection,
        gateway: context.gateway,
        sessionKey: replacementSessionKey,
      });
    }
    context.replace(
      face,
      sessionNavigationTarget({ context, face, sessionKey: replacementSessionKey }).options,
    );
    return true;
  }

  recoverDeletedActiveSession(sessionState: ApplicationContext["sessions"]["state"]): void {
    const context = this.host.context;
    if (!context) {
      return;
    }
    const agentsList = context.agents.state.agentsList;
    const { assistantAgentId, hello } = context.gateway.snapshot;
    const sessionKey = this.host.activeSessionKey.trim();
    let selectedSessionDeleted = false;
    for (const { key, agentId } of sessionState.deletedSessions) {
      void deleteStoredChatSnapshot(
        resolveChatSnapshotKey(
          {
            assistantAgentId: agentId ?? assistantAgentId,
            agentsList,
            hello,
          },
          { sessionKey: key, agentId },
        ),
      );
      selectedSessionDeleted ||= uiSessionEventMatches(
        { agentsList, hello, sessionKey },
        key,
        agentId,
      );
    }
    const routeId = this.host.routeState.routeId;
    if (!routeId || !isSessionRouteId(routeId) || !sessionKey) {
      return;
    }
    if (selectedSessionDeleted) {
      this.replaceChatWithCurrentSession();
    }
  }

  updateRouteState(routeState: ShellRouteState): void {
    this.host.routeState = routeState;
    if (routeState.routeId !== undefined) {
      if (this.host.lastConcreteRouteId === "custodian" && routeState.routeId !== "custodian") {
        this.host.custodianMinimizeRequestId += 1;
      }
      this.host.lastConcreteRouteId = routeState.routeId;
    }
    const committedRouteId = routeState.committedRouteId;
    const committedPathname = routeState.committedLocation?.pathname ?? "";
    const committedSearch = routeState.committedLocation?.search ?? "";
    // Restoration and persistence both wait for a live context: consuming the
    // one-shot restore without a router to call, or persisting the bootstrap
    // route first, would clobber the stored route.
    const routeContext = this.host.context;
    if (committedRouteId && routeContext) {
      // A rendered/pending match that differs from the committed route is an
      // in-flight navigation: it wins over the one-shot restore, and the stale
      // committed route must not be persisted over the remembered destination.
      const pendingDiffers =
        routeState.routeId !== committedRouteId ||
        (routeState.location?.pathname ?? "") !== committedPathname ||
        (routeState.location?.search ?? "") !== committedSearch;
      if (!this.host.didConsiderNativeRouteRestore) {
        this.host.didConsiderNativeRouteRestore = true;
        const storedRoute = pendingDiffers
          ? null
          : considerRouteRestore(committedRouteId, committedPathname, committedSearch);
        if (storedRoute) {
          // Replace instead of push so a fresh window does not start with a
          // Back entry pointing at the bootstrap chat route.
          routeContext.replace(storedRoute.routeId, {
            pathname: storedRoute.pathname,
            search: storedRoute.search,
          });
          return;
        }
      }
      if (!pendingDiffers) {
        const committedSessionKey = routeState.committedSessionKey;
        const committedSessionDeleted =
          committedSessionKey !== undefined &&
          (routeContext.sessions?.state.deletedSessions ?? []).some(({ key, agentId }) =>
            uiSessionEventMatches(
              {
                agentsList: routeContext.agents.state.agentsList,
                hello: routeContext.gateway.snapshot.hello,
                sessionKey: committedSessionKey,
              },
              key,
              agentId,
            ),
          );
        if (committedSessionDeleted) {
          // An older route can commit after deletion recovery has started.
          // Never let it persist or reselect the session we just retired.
          this.replaceChatWithCurrentSession();
          return;
        }
        persistRoute(committedRouteId, committedPathname, committedSearch);
        if (committedSessionKey) {
          this.host.activeSessionKey = committedSessionKey;
          selectApplicationSession({
            selection: routeContext.agentSelection,
            gateway: routeContext.gateway,
            sessionKey: committedSessionKey,
          });
        }
      }
    }
    const context = this.host.context;
    if (context) {
      this.host.ensureAgentsList(context.gateway.snapshot);
    }
    if (routeState.routeId && !isSettingsNavigationRoute(routeState.routeId)) {
      this.host.settingsSearchQuery = "";
      this.host.lastWorkspaceLocation = {
        routeId: routeState.routeId,
        pathname: routeState.location?.pathname ?? "",
        search: routeState.location?.search ?? "",
      };
    }
  }

  /** Agent targeted by the open new-session route, keyed off its ?agent param. */
  newSessionRouteAgentId(): string {
    if (this.host.routeState.routeId !== "new-session") {
      return "";
    }
    return (
      new URLSearchParams(this.host.routeState.location?.search ?? "").get("agent")?.trim() ?? ""
    );
  }

  openNewSession(agentId: string, target?: NewSessionTarget): void {
    this.navigate("new-session", { search: newSessionSearch(agentId, target) });
  }

  exitSettings(): void {
    const previous = this.host.lastWorkspaceLocation;
    if (previous) {
      this.navigate(previous.routeId, {
        pathname: previous.pathname,
        ...(previous.search ? { search: previous.search } : {}),
      });
      return;
    }
    this.navigate("chat");
  }
}
