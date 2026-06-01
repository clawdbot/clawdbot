const INVALID_CRON_SESSION_TARGET_ID_ERROR = "invalid cron sessionTarget session id";

/** Returns whether an error came from cron session target id validation. */
export function isInvalidCronSessionTargetIdError(error: unknown): boolean {
  return error instanceof Error && error.message === INVALID_CRON_SESSION_TARGET_ID_ERROR;
}

/** Validates the opaque session id portion of a `session:` cron target. */
export function assertSafeCronSessionTargetId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) {
    throw new Error(INVALID_CRON_SESSION_TARGET_ID_ERROR);
  }
  if (trimmed.includes("\0")) {
    throw new Error(INVALID_CRON_SESSION_TARGET_ID_ERROR);
  }
  return trimmed;
}

/** Extracts the persistent session key from a `session:` cron target, if present. */
export function resolveCronSessionTargetSessionKey(
  sessionTarget?: string | null,
): string | undefined {
  if (typeof sessionTarget !== "string" || !sessionTarget.startsWith("session:")) {
    return undefined;
  }
  return assertSafeCronSessionTargetId(sessionTarget.slice(8));
}

/** Resolves `current` at creation time so scheduled jobs do not depend on future active UI state. */
export function resolveCronCurrentSessionTarget(params: {
  sessionTarget?: string | null;
  sessionKey?: string | null;
}): string | undefined {
  if (params.sessionTarget !== "current") {
    return params.sessionTarget ?? undefined;
  }
  const sessionKey = params.sessionKey?.trim();
  return sessionKey ? `session:${assertSafeCronSessionTargetId(sessionKey)}` : "isolated";
}

/** Chooses the session key used for cron delivery, preferring explicit persistent targets. */
export function resolveCronDeliverySessionKey(job: {
  sessionTarget?: string | null;
  sessionKey?: string | null;
}): string | undefined {
  const sessionTargetKey = resolveCronSessionTargetSessionKey(job.sessionTarget);
  if (sessionTargetKey) {
    return sessionTargetKey;
  }
  return typeof job.sessionKey === "string" && job.sessionKey.trim()
    ? job.sessionKey.trim()
    : undefined;
}

/** Returns the notification session key, falling back to a stable per-job failure session. */
export function resolveCronNotificationSessionKey(params: {
  jobId: string;
  sessionKey?: string | null;
}): string {
  return typeof params.sessionKey === "string" && params.sessionKey.trim()
    ? params.sessionKey.trim()
    : `cron:${params.jobId}:failure`;
}

/** Resolves the session key used to deliver failure notifications for a cron job. */
export function resolveCronFailureNotificationSessionKey(job: {
  id: string;
  sessionTarget?: string | null;
  sessionKey?: string | null;
}): string {
  return resolveCronNotificationSessionKey({
    jobId: job.id,
    sessionKey: resolveCronDeliverySessionKey(job),
  });
}
