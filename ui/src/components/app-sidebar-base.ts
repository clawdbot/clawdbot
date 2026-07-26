import { consume } from "@lit/context";
import { property } from "lit/decorators.js";
import type { UpdateAvailable } from "../api/types.ts";
import { DEFAULT_SIDEBAR_ENTRIES, type NavigationRouteId } from "../app-navigation.ts";
import type { RouteId } from "../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationNavigationOptions,
} from "../app/context.ts";
import type { CatalogOpenTarget } from "../app/settings.ts";
import type { ThemeMode } from "../app/theme.ts";
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
  @property({ attribute: false }) outboxCountForSession: (sessionKey: string) => number = () => 0;
  @property({ attribute: false }) terminalAvailable = false;
  @property({ attribute: false }) catalogOpenTarget: CatalogOpenTarget = "viewer";
  @property({ attribute: false }) canPairDevice = false;
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
  @property({ attribute: false }) updateRunning = false;
  @property({ attribute: false }) onUpdate: () => void = () => undefined;
  @property({ attribute: false }) onOpenApprovals?: () => void;
  @property({ attribute: false }) onRetryConnect?: () => void;
  @property({ attribute: false }) onOpenNewSession?: (
    agentId: string,
    target?: NewSessionTarget,
  ) => void;
  /** Agent id of the in-flight new-session draft; renders the draft row. */
  @property({ attribute: false }) draftSessionAgentId = "";
  @property({ attribute: false }) onUpdateSidebarEntries?: (entries: string[]) => void;
  @property({ attribute: false }) onPairMobile?: () => void;
  @property({ attribute: false })
  onNavigate?: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
  @property({ attribute: false }) onPreloadRoute?: (routeId: NavigationRouteId) => Promise<void>;

  @consume({ context: applicationContext, subscribe: true })
  protected context?: ApplicationContext<RouteId>;
}
