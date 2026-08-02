const DEFERRED_MAINTENANCE_BLOCKED_ERROR = Symbol.for(
  "openclaw.contextEngineDeferredMaintenanceBlockedError",
);

export class DeferredContextEngineMaintenanceBlockedError extends Error {
  readonly [DEFERRED_MAINTENANCE_BLOCKED_ERROR] = true;
  readonly userMessage: string;

  constructor(params: { quarantined: boolean }) {
    const detail = params.quarantined
      ? "Deferred maintenance did not stop. The context engine was quarantined, but this turn was stopped to avoid overlapping engine operations. Retry after maintenance finishes or restart the gateway."
      : "Deferred maintenance did not stop. The active context engine cannot be quarantined, so this turn was stopped to avoid overlapping engine operations. Retry after maintenance finishes or restart the gateway.";
    super(detail);
    this.name = "DeferredContextEngineMaintenanceBlockedError";
    this.userMessage = `⚠️ ${detail}`;
  }
}

/** Reads the producer-owned recovery copy across duplicated runtime chunks. */
export function resolveDeferredContextEngineMaintenanceBlockedMessage(
  error: unknown,
): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const candidate = error as Record<PropertyKey, unknown>;
  return candidate[DEFERRED_MAINTENANCE_BLOCKED_ERROR] === true &&
    typeof candidate.userMessage === "string"
    ? candidate.userMessage
    : undefined;
}
