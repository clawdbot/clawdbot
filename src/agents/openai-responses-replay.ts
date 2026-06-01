export function resolveReplayableResponsesMessageId(params: {
  replayResponsesItemIds: boolean;
  textSignatureId?: string;
  fallbackId: string;
  fallbackOrdinal: number;
  previousReplayItemWasReasoning: boolean;
}): string | undefined {
  if (!params.replayResponsesItemIds) {
    return undefined;
  }
  if (!params.textSignatureId) {
    return params.fallbackOrdinal === 0
      ? params.fallbackId
      : `${params.fallbackId}_${params.fallbackOrdinal}`;
  }
  return params.previousReplayItemWasReasoning ? params.textSignatureId : undefined;
}
