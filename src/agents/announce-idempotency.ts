type AnnounceIdFromChildRunParams = {
  childSessionKey: string;
  childRunId: string;
};

export function buildAnnounceIdFromChildRun(params: AnnounceIdFromChildRunParams): string {
  return `v1:${params.childSessionKey}:${params.childRunId}`;
}

export function buildAnnounceIdempotencyKey(announceId: string): string {
  return `announce:${announceId}`;
}

export function resolveQueueAnnounceId(params: {
  announceId?: string;
  sessionKey: string;
  enqueuedAt: number;
}): string {
  const announceId = params.announceId?.trim();
  if (announceId) {
    return announceId;
  }
  // Backward-compatible fallback for queue items that predate announceId.
  return `legacy:${params.sessionKey}:${params.enqueuedAt}`;
}
