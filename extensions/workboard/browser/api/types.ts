import type { SessionRow } from "@openclaw/gateway-protocol";

export type { AgentsListResult } from "@openclaw/gateway-protocol";
export type GatewaySessionRow = SessionRow & {
  hasActiveRun?: boolean;
  abortedLastRun?: boolean;
};
