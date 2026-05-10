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
  };
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
  if (entry.expiresAt > 0 && entry.expiresAt < Date.now()) {
    bridgeStatusCache.delete(key);
    return undefined;
  }
  return entry.status;
}

export function setCachedIMessagePrivateApiStatus(
  cliPath: string,
  status: IMessagePrivateApiStatus,
  expiresAt = 0,
): void {
  bridgeStatusCache.set(normalizeCliPath(cliPath), { status, expiresAt });
}

export function clearCachedIMessagePrivateApiStatus(cliPath?: string): void {
  if (cliPath) {
    bridgeStatusCache.delete(normalizeCliPath(cliPath));
  } else {
    bridgeStatusCache.clear();
  }
}
