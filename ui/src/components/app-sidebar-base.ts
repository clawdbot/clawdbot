import { consume } from "@lit/context";
import { property } from "lit/decorators.js";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { DEFAULT_SIDEBAR_ENTRIES, type NavigationRouteId } from "../app-navigation.ts";
import type { RouteId } from "../app-route-paths.ts";
import { selectApplicationSession } from "../app/agent-selection.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationNavigationOptions,
} from "../app/context.ts";
import type { CatalogOpenTarget } from "../app/settings.ts";
import type { ThemeMode } from "../app/theme.ts";
import type { UpdateProgress } from "../app/update-confirmation.ts";
import type { ApplicationStatusBanner } from "../app/update-overlay-helpers.ts";
import { readSessionMethodAccess, type SessionMethodAccess } from "../lib/session-method-access.ts";
import { prepareSessionNavigationHandoff } from "../lib/sessions/navigation-handoff.ts";
import { SESSION_NAVIGATION_KEY_PARAM } from "../lib/sessions/route-navigation.ts";
import { parseAgentSessionKey, resolveUiConfiguredMainKey } from "../lib/sessions/session-key.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import type { SidebarWorkboardBoard, SidebarWorkboardRenderers } from "./app-sidebar-workboard.ts";

/** Stable custom-element inputs. Behavior is layered in focused sidebar modules. */
export abstract class AppSidebarBase extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) basePath = "";
  @property({ attribute: false }) activeRouteId?: NavigationRouteId;
  @property({ attribute: false }) activePluginTabId = "";
  @property({ attribute: false }) activeWorkboardBoardId = "";
  @property({ attribute: false }) enabledRouteIds?: readonly NavigationRouteId[];
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) offline = false;
  @property({ attribute: false }) outboxAttentionCountForSession = (_sessionKey: string) => 0;
  @property({ attribute: false }) hasSessionDraft: (sessionKey: string) => boolean = () => false;
  @property({ attribute: false }) terminalAvailable = false;
  @property({ attribute: false }) catalogOpenTarget: CatalogOpenTarget = "viewer";
  @property({ attribute: false }) canPairDevice = false;
  @property({ attribute: false }) preferencesBrowserOnly = false;
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) sidebarEntries: readonly string[] = DEFAULT_SIDEBAR_ENTRIES;
  @property({ attribute: false }) workboardBoards: readonly SidebarWorkboardBoard[] = [];
  @property({ attribute: false }) workboardBoardsReady = false;
  @property({ attribute: false }) workboardRenderers?: SidebarWorkboardRenderers;
  @property({ attribute: false }) sidebarLiveActivity = true;
  /** Agents surfaced first in the chip quick switcher when many exist. */
  @property({ attribute: false }) pinnedAgentIds: readonly string[] = [];
  @property({ attribute: false }) themeMode: ThemeMode = "system";
  @property({ attribute: false }) lobsterPetVisits = true;
  @property({ attribute: false }) lobsterPetSounds = false;
  @property({ attribute: false }) gatewayVersion: string | null = null;
  @property({ attribute: false }) devGitBranch: string | null = null;
  @property({ attribute: false }) updateAvailable: UpdateAvailable | null = null;
  @property({ attribute: false }) updateSchedule: UpdateScheduleState | null = null;
  @property({ attribute: false }) heldUpdateCampaignId: string | null = null;
  @property({ attribute: false }) updateBusy = false;
  @property({ attribute: false }) updateStatusBanner: ApplicationStatusBanner | null = null;
  @property({ attribute: false }) watchUpdateProgress:
    | ((listener: (progress: UpdateProgress) => void) => () => void)
    | undefined = undefined;
  @property({ attribute: false }) canUpdate = false;
  @property({ attribute: false }) canHoldUpdate = false;
  @property({ attribute: false }) onUpdate: () => void = () => undefined;
  @property({ attribute: false }) refreshRequired = false;
  @property({ attribute: false }) onRefresh: () => void = () => undefined;
  @property({ attribute: false }) onHoldUpdate: () => Promise<boolean> = async () => false;
  @property({ attribute: false }) onReviewUpdate: () => void = () => undefined;
  @property({ attribute: false }) onOpenApprovals?: () => void;
  @property({ attribute: false }) onRetryConnect?: () => void;
  @property({ attribute: false }) onOpenNewSession?: (
    agentId: string,
    target?: NewSessionTarget,
  ) => void;
  @property({ attribute: false }) onUpdateSidebarEntries?: (entries: string[]) => void;
  @property({ attribute: false }) onPairMobile?: () => void;
  @property({ attribute: false })
  onNavigate?: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  @property({ attribute: false }) onPreloadRoute?: (routeId: NavigationRouteId) => Promise<void>;

  @consume({ context: applicationContext, subscribe: true })
  protected context?: ApplicationContext<RouteId>;

  protected setApplicationSession(sessionKey: string, fallbackAgentId?: string): void {
    const context = this.context;
    if (!context) {
      return;
    }
    selectApplicationSession({
      selection: context.agentSelection,
      gateway: context.gateway,
      sessionKey,
      agentId: parseAgentSessionKey(sessionKey)?.agentId ?? fallbackAgentId,
    });
  }

  prepareSessionNavigation(sessionKey: string, pathname: string): void {
    if (this.context) {
      prepareSessionNavigationHandoff(this.context.gateway, pathname, sessionKey);
    }
  }

  protected bindLiteralSession(
    sessionKey: string,
    fallbackAgentId: string,
    options: ApplicationNavigationOptions,
  ): void {
    if (!new URLSearchParams(options.search ?? "").has(SESSION_NAVIGATION_KEY_PARAM)) {
      this.setApplicationSession(sessionKey, fallbackAgentId);
    }
  }

  protected sessionMainKey(): string {
    return resolveUiConfiguredMainKey({
      agentsList: this.context?.agents.state.agentsList,
      hello: this.context?.gateway.snapshot.hello,
    });
  }

  readNewSessionAccess(): SessionMethodAccess {
    return readSessionMethodAccess(this.connected ? this.context?.gateway.snapshot : null, {
      method: "sessions.create",
      params: {},
    });
  }

  readSessionMutationAccess(request: {
    method: string;
    params?: unknown;
    requiredScope?: "operator.write" | "operator.admin";
  }): SessionMethodAccess {
    return readSessionMethodAccess(this.connected ? this.context?.gateway.snapshot : null, request);
  }

  requestOpenNewSession(agentId: string, target?: NewSessionTarget): void {
    if (this.readNewSessionAccess().allowed) {
      if (target) {
        this.onOpenNewSession?.(agentId, target);
      } else {
        this.onOpenNewSession?.(agentId);
      }
    }
  }
}
