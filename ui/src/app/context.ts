import { createContext } from "@lit/context";
import type { RouteLocation } from "@openclaw/uirouter";
import type { RouteId } from "../app-route-paths.ts";
import type { AgentIdentityCapability } from "../lib/agents/identity.ts";
import type { AgentCapability } from "../lib/agents/index.ts";
import type { ChannelCapability } from "../lib/channels/index.ts";
import type { ChatAttachment, ChatComposerMemoryFallback } from "../lib/chat/chat-types.ts";
import type { RuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import type { WorkboardCapability } from "../lib/workboard/capability.ts";
import type { AgentSelectionCapability } from "./agent-selection.ts";
import type { ApplicationCloudStartup } from "./cloud-session-startup.ts";
import type { ApplicationConfigCapability } from "./config.ts";
import type { ApplicationGateway } from "./gateway.ts";
import type { ApplicationInitialUserMessageHandoff } from "./initial-user-message-handoff.ts";
import type { NativeChatDrafts } from "./native-bridge.ts";
import type { NativeNotificationsCapability } from "./native-notifications.ts";
import type { ApplicationOverlays } from "./overlays-types.ts";
import type { ThemeMode, ThemeName } from "./theme.ts";
import type { WebPushCapability } from "./web-push.ts";

export type {
  ApplicationGateway,
  ApplicationGatewayConnection,
  ApplicationGatewayConnectOptions,
  ApplicationGatewaySnapshot,
} from "./gateway.ts";

export type ApplicationThemeServerSelection = {
  readonly revision: number;
  readonly scope: string;
  readonly theme: ThemeName | null;
};

export type ApplicationTheme = {
  readonly mode: ThemeMode;
  readonly serverSelection: ApplicationThemeServerSelection | null;
  recordServerSelection: (theme: ThemeName | null, scope: string) => void;
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
  /** Stable for ordinary snapshots and session selection; rotates on reconnect. */
  owner: object;
  proposalId: string;
  proposalAgentId: string;
};

export type ApplicationSkillWorkshopRevisionHandoff = {
  prepare: (handoff: SkillWorkshopRevisionHandoff) => void;
  consume: (sessionKey: string, owner: object | null) => SkillWorkshopRevisionHandoff | null;
  clear: (handoff?: SkillWorkshopRevisionHandoff) => void;
};

type ChatAttachmentHandoffKey = {
  owner: ApplicationGateway["snapshot"]["client"];
  paneId: string;
  scopeKey: string;
};

export type ApplicationChatAttachmentHandoff = {
  prepare(
    handoff: ChatAttachmentHandoffKey & {
      attachments: readonly ChatAttachment[];
      fallbacks: Readonly<Record<string, ChatComposerMemoryFallback>>;
      message?: string;
    },
  ): void;
  consume(handoff: ChatAttachmentHandoffKey): {
    attachments: ChatAttachment[];
    fallbacks: Record<string, ChatComposerMemoryFallback>;
    message?: string;
  } | null;
  clearPane(paneId: string): void;
  dispose(): void;
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
  readonly cloudStartup: ApplicationCloudStartup;
  readonly workboard: WorkboardCapability;
  readonly overlays: ApplicationOverlays;
  readonly navigation: ApplicationNavigationPreferences;
  readonly theme: ApplicationTheme;
  readonly nativeChatDrafts: NativeChatDrafts;
  readonly nativeNotifications: NativeNotificationsCapability | null;
  readonly webPush: WebPushCapability;
  readonly skillWorkshopRevision: ApplicationSkillWorkshopRevisionHandoff;
  readonly initialUserMessage: ApplicationInitialUserMessageHandoff;
  readonly chatAttachmentHandoff: ApplicationChatAttachmentHandoff;
  readonly navigate: (routeId: TRouteId, options?: ApplicationNavigationOptions) => void;
  /** Navigates and resolves after any route-specific handoff completes. */
  readonly navigateAndWait: (
    routeId: TRouteId,
    options?: ApplicationNavigationOptions,
  ) => Promise<void>;
  readonly replace: (routeId: TRouteId, options?: ApplicationNavigationOptions) => void;
  readonly revalidate: (routeId?: TRouteId) => Promise<void>;
  readonly preload: (routeId: TRouteId, options?: ApplicationNavigationOptions) => Promise<void>;
};

export const applicationContext =
  createContext<ApplicationContext<RouteId>>("openclaw.application");
