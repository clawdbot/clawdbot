export function logMemoryVectorDegradedWrite(params: {
  vectorEnabled: boolean;
  vectorReady: boolean;
  chunkCount: number;
  warningShown: boolean;
  loadError?: string;
  warn: (message: string) => void;
}): boolean {
  if (
    !params.vectorEnabled ||
    params.vectorReady ||
    params.chunkCount <= 0 ||
    params.warningShown
  ) {
    return params.warningShown;
  }
  const errDetail = params.loadError ? `: ${params.loadError}` : "";
  params.warn(
    `chunks_vec not updated — sqlite-vec unavailable${errDetail}. Vector recall degraded. Further duplicate warnings suppressed.`,
  );
  return true;
}
