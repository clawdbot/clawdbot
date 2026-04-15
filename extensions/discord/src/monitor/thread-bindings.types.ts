export type ThreadBindingTargetKind = "subagent" | "acp";

export type ThreadBindingRecord = {
  accountId: string;
  channelId: string;
  threadId: string;
  targetKind: ThreadBindingTargetKind;
  targetSessionKey: string;
  agentId: string;
  label?: string;
  webhookId?: string;
  webhookToken?: string;
  boundBy: string;
  boundAt: number;
  lastActivityAt: number;
  /** Inactivity timeout window in milliseconds (0 disables inactivity auto-unfocus). */
  idleTimeoutMs?: number;
  /** Hard max-age window in milliseconds from bind time (0 disables hard cap). */
  maxAgeMs?: number;
  metadata?: Record<string, unknown>;
};

export type PersistedThreadBindingRecord = ThreadBindingRecord & {
  sessionKey?: string;
  /** @deprecated Legacy absolute expiry timestamp; migrated on load. */
  expiresAt?: number;
};

export type PersistedThreadBindingsPayload = {
  version: 1;
  bindings: Record<string, PersistedThreadBindingRecord>;
};

export type ThreadBindingManager = {
  accountId: string;
  getIdleTimeoutMs: () => number;
  getMaxAgeMs: () => number;
  getByThreadId: (threadId: string) => ThreadBindingRecord | undefined;
  getBySessionKey: (targetSessionKey: string) => ThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => ThreadBindingRecord[];
  listBindings: () => ThreadBindingRecord[];
  touchThread: (params: {
    threadId: string;
    at?: number;
    persist?: boolean;
  }) => ThreadBindingRecord | null;
  bindTarget: (params: {
    threadId?: string | number;
    channelId?: string;
    createThread?: boolean;
    threadName?: string;
    targetKind: ThreadBindingTargetKind;
    targetSessionKey: string;
    agentId?: string;
    label?: string;
    boundBy?: string;
    introText?: string;
    webhookId?: string;
    webhookToken?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<ThreadBindingRecord | null>;
  unbindThread: (params: {
    threadId: string;
    reason?: string;
    sendFarewell?: boolean;
    farewellText?: string;
  }) => ThreadBindingRecord | null;
  unbindBySessionKey: (params: {
    targetSessionKey: string;
    targetKind?: ThreadBindingTargetKind;
    reason?: string;
    sendFarewell?: boolean;
    farewellText?: string;
  }) => ThreadBindingRecord[];
  stop: () => void;
};

export const THREAD_BINDINGS_VERSION = 1 as const;
export const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 120_000;
export const DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_THREAD_BINDING_MAX_AGE_MS = 0; // disabled
export const DEFAULT_FAREWELL_TEXT = "Thread unfocused. Messages here will no longer be routed.";
export const DISCORD_UNKNOWN_CHANNEL_ERROR_CODE = 10_003;
export const RECENT_UNBOUND_WEBHOOK_ECHO_WINDOW_MS = 30_000;
