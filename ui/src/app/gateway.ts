import type { EventLogEntry } from "../api/event-log.ts";
import type { GatewayBrowserClient, GatewayEventListener, GatewayHelloOk } from "../api/gateway.ts";
import type { AuthenticatedUser } from "./user-profile.ts";

export type ApplicationGatewaySnapshot = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  offlineStable: boolean;
  /**
   * Disconnected, but a session existed this page lifetime and the client is
   * still auto-retrying. The shell stays mounted with offline presentation in
   * this state instead of falling back to the login gate.
   */
  reconnecting: boolean;
  hello: GatewayHelloOk | null;
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
  password: string;
};

export type ApplicationGatewayConnectOptions = Partial<ApplicationGatewayConnection> & {
  sessionKey?: string;
};

export type ApplicationGateway = {
  readonly snapshot: ApplicationGatewaySnapshot;
  readonly connection: ApplicationGatewayConnection;
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
