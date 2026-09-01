// Correlates an observable bootstrap bearer with the exact pending approval it created.

type PendingBootstrapIdentityBinding = {
  token: string;
  deviceId: string;
  publicKey: string;
  role: string;
  scopes: readonly string[];
  expiresAtMs: number;
};

const pendingBindings = new Map<string, PendingBootstrapIdentityBinding>();

function pruneExpiredBindings(now = Date.now()): void {
  for (const [requestId, binding] of pendingBindings) {
    if (binding.expiresAtMs <= now) {
      pendingBindings.delete(requestId);
    }
  }
}

/** Keep bearer identity private and bounded by the pending request lifecycle. */
export function registerBootstrapIdentityBinding(
  requestId: string,
  binding: PendingBootstrapIdentityBinding,
): void {
  pruneExpiredBindings();
  pendingBindings.set(requestId, binding);
}

export function clearBootstrapIdentityBinding(requestId: string): void {
  pendingBindings.delete(requestId);
}

/** Consume only the binding authorized by the exact committed pairing request. */
export function takeApprovedBootstrapIdentityBinding(params: {
  requestId: string;
  deviceId: string;
  publicKey: string;
}): PendingBootstrapIdentityBinding | null {
  pruneExpiredBindings();
  const binding = pendingBindings.get(params.requestId);
  pendingBindings.delete(params.requestId);
  if (!binding || binding.deviceId !== params.deviceId || binding.publicKey !== params.publicKey) {
    return null;
  }
  return binding;
}
