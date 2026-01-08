export type PortListener = {
  pid?: number;
  command?: string;
  commandLine?: string;
  user?: string;
  address?: string;
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
