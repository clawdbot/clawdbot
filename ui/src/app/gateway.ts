import type { ControlModel } from "@openclaw/gateway-client/model";
import type { ControlModelCatalog } from "@openclaw/gateway-client/model/catalog";
import type { ControlUiBootstrapProfileHint } from "../../../src/gateway/control-ui-contract.js";
import type { EventLogEntry } from "../api/event-log.ts";
import type { GatewayBrowserClient, GatewayEventListener, GatewayHelloOk } from "../api/gateway.ts";
import type { AuthenticatedUser } from "./user-profile.ts";

export type ApplicationGatewayPhase =
  | "stopped"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline";

export type ApplicationGatewaySnapshot = {
  client: GatewayBrowserClient | null;
  phase: ApplicationGatewayPhase;
  offlineStable: boolean;
  hello: GatewayHelloOk | null;
  canvasPluginSurfaceUrl: string | null;
  assistantAgentId: string | null;
  sessionKey: string;
  lastError: string | null;
  lastErrorCode: string | null;
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
  readonly eventLog: readonly EventLogEntry[];
  /** Framework-neutral state binding for the Control UI's Gateway client. */
  /** Loads the shared catalog runtime on first session-roster use. */
  readonly loadControlModelCatalog?: () => Promise<ControlModelCatalog>;
  /** Loads the conversation projection without duplicating catalog ownership. */
  readonly loadControlModel?: () => Promise<ControlModel>;
  connect: (connection?: ApplicationGatewayConnectOptions) => void;
  setSessionKey: (sessionKey: string) => void;
  start: () => void;
  stop: () => void;
  /** Permanently releases Gateway-owned shared capabilities. */
  dispose: () => void;
  subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => () => void;
  subscribeEventLog: (listener: (events: readonly EventLogEntry[]) => void) => () => void;
  subscribeEvents: (listener: GatewayEventListener) => () => void;
  updateSelfUser?: (patch: Partial<Omit<AuthenticatedUser, "id">>) => void;
};
