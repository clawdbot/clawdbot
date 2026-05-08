export type GatewayAgentIdentity = {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
  avatarUrl?: string;
};

export type GatewayAgentModel = {
  primary?: string;
  fallbacks?: string[];
};

export type GatewayAgentRuntime = {
  id: string;
  fallback?: "pi" | "none";
  source: "env" | "agent" | "defaults" | "model" | "provider" | "implicit";
};

export type GatewayAgentRow = {
  id: string;
  name?: string;
  identity?: GatewayAgentIdentity;
  workspace?: string;
  model?: GatewayAgentModel;
  agentRuntime?: GatewayAgentRuntime;
};

export type SessionsListResultBase<TDefaults, TRow> = {
  ts: number;
  path: string;
  count: number;
  totalCount?: number;
  limitApplied?: number;
  hasMore?: boolean;
  defaults: TDefaults;
  sessions: TRow[];
};

export type SessionsPatchResultBase<TEntry> = {
  ok: true;
  path: string;
  key: string;
  entry: TEntry;
};
