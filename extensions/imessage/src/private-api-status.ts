// Imessage plugin module implements private api status behavior.
import { asDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";

export type IMessagePrivateApiStatus = {
  available: boolean;
  v2Ready: boolean;
  selectors: Record<string, boolean>;
  rpcMethods: string[];
  // CLI-flag-level capabilities probed from `imsg <cmd> --help`. Only fields
  // we actively branch on are listed; missing entries mean "not yet probed"
  // and callers should treat them as unsupported.
  cliCapabilities?: {
    sendRichSupportsAttachment?: boolean;
    pollSendSupportsNoComment?: boolean;
  };
  // imsg's own `status --json` `message` field. When advanced features are off
  // it explains why (SIP enabled, library validation, macOS 26 AMFI gate), so
  // callers can surface a real reason instead of a generic "run imsg launch".
  statusMessage?: string;
  error?: string;
};

type PrivateApiCacheEntry = {
  status: IMessagePrivateApiStatus;
  expiresAt: number;
};

// Methods that have always existed on imsg's rpc surface, before the
// `rpc_methods` capability list was added. An older imsg build that
// reports `available: true` but ships no rpc_methods array is assumed to
// support these; newer/private bridge methods remain explicit.
const FOUNDATIONAL_RPC_METHODS = new Set<string>([
  "chats.list",
  "messages.history",
  "watch.subscribe",
  "watch.unsubscribe",
  "send",
]);

const bridgeStatusCache = new Map<string, PrivateApiCacheEntry>();

function normalizeCliPath(cliPath?: string | null): string {
  return cliPath?.trim() || "imsg";
}

export function imessageRpcSupportsMethod(
  status: IMessagePrivateApiStatus | undefined,
  method: string,
): boolean {
  if (!status?.available) {
    return false;
  }
  if (status.rpcMethods.length === 0) {
    return FOUNDATIONAL_RPC_METHODS.has(method);
  }
  return status.rpcMethods.includes(method);
}

export function getCachedIMessagePrivateApiStatus(
  cliPath?: string | null,
): IMessagePrivateApiStatus | undefined {
  const key = normalizeCliPath(cliPath);
  const entry = bridgeStatusCache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt === 0) {
    return entry.status;
  }
  const now = asDateTimestampMs(Date.now());
  if (now === undefined || entry.expiresAt <= now) {
    bridgeStatusCache.delete(key);
    return undefined;
  }
  return entry.status;
}

// How long an observed stall outranks imsg's own status claim.
//
// The probe decides availability from `imsg status --json`, but that reports
// the injected helper as connected from a stale handshake and keeps saying so
// while the helper is wedged. Evicting the cache alone therefore re-caches the
// same false positive on the next probe. A stall is first-hand RPC evidence and
// has to outrank the claim until either real traffic proves the bridge answers
// again or this window lapses.
const BRIDGE_STALL_TTL_MS = 60 * 1000;

const bridgeStallUntil = new Map<string, number>();

// Record first-hand evidence that the bridge stopped answering RPC.
export function recordIMessageBridgeStall(cliPath?: string | null): void {
  const key = normalizeCliPath(cliPath);
  bridgeStallUntil.set(key, Date.now() + BRIDGE_STALL_TTL_MS);
  bridgeStatusCache.delete(key);
}

// Record first-hand evidence that the bridge answered.
//
// Any successful RPC clears the stall. Normal sends are not capability-gated,
// so one working send releases the capability path immediately instead of
// making it wait out the window.
export function recordIMessageBridgeAlive(cliPath?: string | null): void {
  bridgeStallUntil.delete(normalizeCliPath(cliPath));
}

export function isIMessageBridgeStalled(cliPath?: string | null): boolean {
  const key = normalizeCliPath(cliPath);
  const until = bridgeStallUntil.get(key);
  if (until === undefined) {
    return false;
  }
  if (until <= Date.now()) {
    bridgeStallUntil.delete(key);
    return false;
  }
  return true;
}

export function setCachedIMessagePrivateApiStatus(
  cliPath: string,
  status: IMessagePrivateApiStatus,
  expiresAt = 0,
): void {
  if (expiresAt !== 0 && asDateTimestampMs(expiresAt) === undefined) {
    return;
  }
  bridgeStatusCache.set(normalizeCliPath(cliPath), { status, expiresAt });
}
