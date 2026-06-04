// Port probe types are shared by lsof/netstat readers and CLI status formatters.
/** Process metadata for one listener on a port. */
export type PortListener = {
  pid?: number;
  ppid?: number;
  command?: string;
  commandLine?: string;
  user?: string;
  address?: string;
};

export type PortConnectionDirection = "client" | "server" | "unknown";

/** Listener plus inferred client/server direction. */
export type PortConnection = PortListener & {
  direction: PortConnectionDirection;
};

export type PortUsageStatus = "free" | "busy" | "unknown";

/** Port usage summary returned by port probes. */
export type PortUsage = {
  port: number;
  status: PortUsageStatus;
  listeners: PortListener[];
  hints: string[];
  detail?: string;
  errors?: string[];
};

export type PortListenerKind = "gateway" | "ssh" | "unknown";

/** Connection list for a single port probe. */
export type PortConnections = {
  port: number;
  connections: PortConnection[];
  detail?: string;
  errors?: string[];
};
