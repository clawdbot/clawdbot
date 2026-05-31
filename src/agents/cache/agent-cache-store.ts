export type AgentRuntimeCacheValue = {
  agentId: string;
  scope: string;
  key: string;
  value: unknown;
  blob?: Buffer;
  expiresAt: number | null;
  updatedAt: number;
};

export type AgentRuntimeCacheWriteOptions = {
  key: string;
  value?: unknown;
  blob?: Buffer | string;
  expiresAt?: number | null;
  ttlMs?: number;
};

export type AgentRuntimeCacheStore = {
  write(options: AgentRuntimeCacheWriteOptions): AgentRuntimeCacheValue;
  read(key: string): AgentRuntimeCacheValue | null;
  list(): AgentRuntimeCacheValue[];
  delete(key: string): boolean;
  clear(): number;
  clearExpired(now?: number): number;
};
