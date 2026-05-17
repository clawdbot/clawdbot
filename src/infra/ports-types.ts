export type PortListener = {
  pid?: number;
  ppid?: number;
  command?: string;
  commandLine?: string;
  user?: string;
  address?: string;
};

export type PortConnectionDirection = "client" | "server" | "unknown";

export type PortConnection = PortListener & {
  direction: PortConnectionDirection;
};

export type PortUsageStatus = "free" | "busy" | "unknown";

export type PortUsage = {
  port: number;
  status: PortUsageStatus;
  listeners: PortListener[];
  hints: string[];
  detail?: string;
  errors?: string[];
};

export type PortListenerKind = "gateway" | "ssh" | "unknown";

export type PortConnections = {
  port: number;
  connections: PortConnection[];
  detail?: string;
  errors?: string[];
};
