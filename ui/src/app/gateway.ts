import type { GatewaySuspension } from "../../../packages/gateway-protocol/src/schema/gateway-suspend.js";
import type { ControlUiBootstrapProfileHint } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import type { EventLogEntry } from "../api/event-log.ts";
import type { GatewayBrowserClient, GatewayEventListener, GatewayHelloOk } from "../api/gateway.ts";
import type { AuthenticatedUser } from "./user-profile.ts";

export type ApplicationGatewayPhase =
  | "stopped"
  | "connecting"
  | "starting"
  | "connected"
  | "reconnecting"
  | "reload-required"
  | "offline";

export type ApplicationGatewaySnapshot = {
  client: GatewayBrowserClient | null;
  phase: ApplicationGatewayPhase;
  offlineStable: boolean;
  restartPending?: boolean;
  suspensionPhase?: GatewaySuspension["phase"];
  hello: GatewayHelloOk | null;
  canvasPluginSurfaceUrl: string | null;
  assistantAgentId: string | null;
  sessionKey: string;
  lastError: string | null;
  lastErrorCode: string | null;
  lastErrorAuthReason?: string | null;
  /** Identity projected from this browser connection's own presence entry. */
  selfUser?: AuthenticatedUser | null;
};

export type ApplicationGatewayConnection = {
  gatewayUrl: string;
  token: string;
  bootstrapToken: string;
  bootstrapProfile?: ControlUiBootstrapProfileHint;
  password: string;
};

export type ApplicationGatewayConnectOptions = Partial<ApplicationGatewayConnection> & {
  sessionKey?: string;
};

export type ApplicationGateway = {
  readonly snapshot: ApplicationGatewaySnapshot;
  readonly connection: ApplicationGatewayConnection;
  readonly connectionRevision: number;
  readonly eventLog: readonly EventLogEntry[];
  connect: (connection?: ApplicationGatewayConnectOptions) => void;
  setSessionKey: (sessionKey: string) => void;
  start: () => void;
  stop: () => void;
  subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => () => void;
  subscribeEventLog: (listener: (events: readonly EventLogEntry[]) => void) => () => void;
  subscribeEvents: (listener: GatewayEventListener) => () => void;
  updateSelfUser?: (patch: Partial<Omit<AuthenticatedUser, "id">>) => void;
};
