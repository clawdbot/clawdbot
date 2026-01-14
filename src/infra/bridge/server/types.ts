import type { NodePairingPendingRequest } from "../../node-pairing.js";

export type BridgeHelloFrame = {
  type: "hello";
  nodeId: string;
  displayName?: string;
  token?: string;
  platform?: string;
  version?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
};

export type BridgePairRequestFrame = {
  type: "pair-request";
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  remoteAddress?: string;
  silent?: boolean;
};

export type BridgeEventFrame = {
  type: "event";
  event: string;
  payloadJSON?: string | null;
};

export type BridgeRPCRequestFrame = {
  type: "req";
  id: string;
  method: string;
  paramsJSON?: string | null;
};

export type BridgeRPCResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payloadJSON?: string | null;
  error?: { code: string; message: string; details?: unknown } | null;
};

export type BridgePingFrame = { type: "ping"; id: string };
export type BridgePongFrame = { type: "pong"; id: string };

export type BridgeInvokeRequestFrame = {
  type: "invoke";
  id: string;
  command: string;
  paramsJSON?: string | null;
};

export type BridgeInvokeResponseFrame = {
  type: "invoke-res";
  id: string;
  ok: boolean;
  payloadJSON?: string | null;
  error?: { code: string; message: string } | null;
};

export type BridgeHelloOkFrame = {
  type: "hello-ok";
  serverName: string;
  canvasHostUrl?: string;
};

export type BridgePairOkFrame = { type: "pair-ok"; token: string };
export type BridgeErrorFrame = { type: "error"; code: string; message: string };

export type AnyBridgeFrame =
  | BridgeHelloFrame
  | BridgePairRequestFrame
  | BridgeEventFrame
  | BridgeRPCRequestFrame
  | BridgeRPCResponseFrame
  | BridgePingFrame
  | BridgePongFrame
  | BridgeInvokeRequestFrame
  | BridgeInvokeResponseFrame
  | BridgeHelloOkFrame
  | BridgePairOkFrame
  | BridgeErrorFrame
  | { type: string; [k: string]: unknown };

export type NodeBridgeServer = {
  port: number;
  close: () => Promise<void>;
  invoke: (opts: {
    nodeId: string;
    command: string;
    paramsJSON?: string | null;
    timeoutMs?: number;
  }) => Promise<BridgeInvokeResponseFrame>;
  sendEvent: (opts: {
    nodeId: string;
    event: string;
    payloadJSON?: string | null;
  }) => void;
  listConnected: () => NodeBridgeClientInfo[];
  listeners: Array<{ host: string; port: number }>;
};

export type NodeBridgeClientInfo = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
};

export type NodeBridgeServerOpts = {
  host: string;
  port: number; // 0 = ephemeral
  pairingBaseDir?: string;
  canvasHostPort?: number;
  canvasHostHost?: string;
  onEvent?: (nodeId: string, evt: BridgeEventFrame) => Promise<void> | void;
  onRequest?: (
    nodeId: string,
    req: BridgeRPCRequestFrame,
  ) => Promise<
    | { ok: true; payloadJSON?: string | null }
    | { ok: false; error: { code: string; message: string; details?: unknown } }
  >;
  onAuthenticated?: (node: NodeBridgeClientInfo) => Promise<void> | void;
  onDisconnected?: (node: NodeBridgeClientInfo) => Promise<void> | void;
  onPairRequested?: (
    request: NodePairingPendingRequest,
  ) => Promise<void> | void;
  serverName?: string;
};
