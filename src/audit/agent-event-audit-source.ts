function legacyAuditSourceId(params: {
  runId: string;
  sourceSequence: number;
  occurredAt: number;
  action: string;
}): string {
  // Preserve the original store-owned identity byte-for-byte so replayed
  // run/tool events still deduplicate after the versioned contract refactor.
  return `${params.runId}:${params.sourceSequence}:${params.occurredAt}:${params.action}`;
}

export function auditSourceIdentity(
  params: Parameters<typeof legacyAuditSourceId>[0] & { lifecycleGeneration?: string },
): { sourceId: string; legacySourceId?: string } {
  const legacySourceId = legacyAuditSourceId(params);
  return params.lifecycleGeneration
    ? {
        sourceId: `lifecycle:${params.lifecycleGeneration}:${legacySourceId}`,
        legacySourceId,
      }
    : { sourceId: legacySourceId };
}
