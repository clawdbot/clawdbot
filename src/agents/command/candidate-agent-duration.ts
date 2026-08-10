export function createCandidateAgentDurationOwner(
  observe: ((durationMs: number) => void) | undefined,
  now: () => number = performance.now.bind(performance),
): { markTerminal: () => void } {
  const startedAt = now();
  let marked = false;
  return {
    markTerminal() {
      if (marked) {
        return;
      }
      marked = true;
      const elapsed = now() - startedAt;
      const durationMs = Number.isFinite(elapsed)
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(elapsed)))
        : 0;
      observe?.(durationMs);
    },
  };
}
