import type { EventEmitter } from "node:events";
import type { GatewayPlugin } from "@buape/carbon/gateway";

export type DiscordGatewayHandle = Pick<GatewayPlugin, "disconnect"> & {
  emitter?: EventEmitter;
};

type GatewaySocketListener = (...args: unknown[]) => void;

export type DiscordGatewaySocket = {
  on: (event: "close" | "error", listener: GatewaySocketListener) => unknown;
  listeners: (event: "close" | "error") => GatewaySocketListener[];
  removeListener: (event: "close" | "error", listener: GatewaySocketListener) => unknown;
  terminate?: () => void;
};

export type MutableDiscordGateway = GatewayPlugin & {
  emitter?: EventEmitter;
  options: Record<string, unknown> & {
    reconnect?: {
      maxAttempts?: number;
    };
  };
  state?: {
    sessionId?: string | null;
    resumeGatewayUrl?: string | null;
    sequence?: number | null;
  };
  sequence?: number | null;
  ws?: DiscordGatewaySocket | null;
};
