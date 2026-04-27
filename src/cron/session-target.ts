export const INVALID_CRON_SESSION_TARGET_ID_ERROR = "invalid cron sessionTarget session id";

export function isInvalidCronSessionTargetIdError(error: unknown): boolean {
  return error instanceof Error && error.message === INVALID_CRON_SESSION_TARGET_ID_ERROR;
}

export function assertSafeCronSessionTargetId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) {
    throw new Error(INVALID_CRON_SESSION_TARGET_ID_ERROR);
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error(INVALID_CRON_SESSION_TARGET_ID_ERROR);
  }
  return trimmed;
}

export function resolveCronSessionTargetSessionKey(
  sessionTarget?: string | null,
): string | undefined {
  if (typeof sessionTarget !== "string" || !sessionTarget.startsWith("session:")) {
    return undefined;
  }
  return assertSafeCronSessionTargetId(sessionTarget.slice(8));
}

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

export function resolveCronNotificationSessionKey(params: {
  jobId: string;
  sessionKey?: string | null;
}): string {
  return typeof params.sessionKey === "string" && params.sessionKey.trim()
    ? params.sessionKey.trim()
    : `cron:${params.jobId}:failure`;
}

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
