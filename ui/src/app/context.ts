import { createContext } from "@lit/context";
import type { RouteLocation } from "@openclaw/uirouter";
import type { RouteId } from "../app-route-paths.ts";
import type { AgentIdentityCapability } from "../lib/agents/identity.ts";
import type { AgentCapability } from "../lib/agents/index.ts";
import type { ChannelCapability } from "../lib/channels/index.ts";
import type { RuntimeConfigCapability } from "../lib/config/index.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import type { WorkboardCapability } from "../lib/workboard/capability.ts";
import type { AgentSelectionCapability } from "./agent-selection.ts";
import type { ApplicationConfigCapability } from "./config.ts";
import type { ApplicationGateway } from "./gateway.ts";
import type { NativeChatDrafts } from "./native-bridge.ts";
import type { NativeNotificationsCapability } from "./native-notifications.ts";
import type { ApplicationOverlays } from "./overlays.ts";
import type { ThemeMode } from "./theme.ts";
import type { WebPushCapability } from "./web-push.ts";

export type {
  ApplicationGateway,
  ApplicationGatewayConnection,
  ApplicationGatewayConnectOptions,
  ApplicationGatewaySnapshot,
} from "./gateway.ts";

export type ApplicationTheme = {
  readonly mode: ThemeMode;
  setMode: (mode: ThemeMode, element?: HTMLElement | null) => void;
  refresh: () => void;
  subscribe: (listener: () => void) => () => void;
};

export type ApplicationNavigationPreferencesSnapshot = {
  navCollapsed: boolean;
  navWidth: number;
  sidebarEntries: readonly string[];
  pinnedAgentIds: readonly string[];
};

export type ApplicationNavigationPreferences = {
  readonly snapshot: ApplicationNavigationPreferencesSnapshot;
  update: (patch: Partial<ApplicationNavigationPreferencesSnapshot>) => void;
  subscribe: (listener: (snapshot: ApplicationNavigationPreferencesSnapshot) => void) => () => void;
};

export type ApplicationNavigationOptions = Partial<
  Pick<RouteLocation, "pathname" | "search" | "hash">
>;

type SkillWorkshopRevisionHandoff = {
  sessionKey: string;
  instructions: string;
  proposalId: string;
  proposalAgentId: string;
};

export type ApplicationSkillWorkshopRevisionHandoff = {
  prepare: (handoff: SkillWorkshopRevisionHandoff) => void;
  consume: (sessionKey: string) => SkillWorkshopRevisionHandoff | null;
  clear: () => void;
};

export type ApplicationInitialUserMessage = {
  role: "user";
  content: unknown[];
  timestamp: number;
  __openclaw?: { idempotencyKey?: string; seq?: number };
};

type InitialUserMessageHandoff = {
  message: ApplicationInitialUserMessage;
  owner: object;
  sessionKey: string;
};

export type ApplicationInitialUserMessageHandoff = {
  prepare: (handoff: InitialUserMessageHandoff) => void;
  read: (sessionKey: string, owner: object | null) => ApplicationInitialUserMessage | null;
  clear: (sessionKey?: string) => void;
};

export type ApplicationContext<TRouteId extends string = string> = {
  readonly basePath: string;
  readonly gateway: ApplicationGateway;
  readonly agents: AgentCapability;
  readonly agentIdentity: AgentIdentityCapability;
  readonly agentSelection: AgentSelectionCapability;
  readonly channels: ChannelCapability;
  readonly config: ApplicationConfigCapability;
  readonly runtimeConfig: RuntimeConfigCapability;
  readonly sessions: SessionCapability;
  readonly workboard: WorkboardCapability;
  readonly overlays: ApplicationOverlays;
  readonly navigation: ApplicationNavigationPreferences;
  readonly theme: ApplicationTheme;
  readonly nativeChatDrafts: NativeChatDrafts;
  readonly nativeNotifications: NativeNotificationsCapability | null;
  readonly webPush: WebPushCapability;
  readonly skillWorkshopRevision: ApplicationSkillWorkshopRevisionHandoff;
  readonly initialUserMessage: ApplicationInitialUserMessageHandoff;
  readonly navigate: (routeId: TRouteId, options?: ApplicationNavigationOptions) => void;
  readonly replace: (routeId: TRouteId, options?: ApplicationNavigationOptions) => void;
  readonly revalidate: (routeId?: TRouteId) => Promise<void>;
  readonly preload: (routeId: TRouteId) => Promise<void>;
};

export const applicationContext =
  createContext<ApplicationContext<RouteId>>("openclaw.application");
