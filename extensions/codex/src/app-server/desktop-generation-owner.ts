const SETTLE_DELAY_MS = 1_000;

export type CodexDesktopGeneration = Readonly<{ epoch: number; fingerprint: string }>;

/** Coalesces filesystem invalidations into one stable desktop generation. */
export function createCodexDesktopGenerationOwner(params: {
  readFingerprint: () => Promise<string>;
  onGenerationChange?: (generation: CodexDesktopGeneration) => void;
  initialGeneration?: CodexDesktopGeneration;
}) {
  let generation = params.initialGeneration;
  let invalidation = 0;
  let dirty = false;
  let refresh: Promise<CodexDesktopGeneration> | undefined;
  let stopped = false;

  const markDirty = () => {
    invalidation += 1;
    dirty = true;
  };
  const reconcile = () => {
    if (refresh) {
      return refresh;
    }
    refresh = (async () => {
      for (;;) {
        if (stopped) {
          throw new Error("Codex desktop generation owner stopped");
        }
        const observedInvalidation = invalidation;
        const first = await params.readFingerprint();
        await delay(SETTLE_DELAY_MS);
        if (stopped) {
          throw new Error("Codex desktop generation owner stopped");
        }
        const second = await params.readFingerprint();
        if (stopped) {
          throw new Error("Codex desktop generation owner stopped");
        }
        if (observedInvalidation !== invalidation || first !== second) {
          continue;
        }
        const previous = generation;
        generation =
          previous?.fingerprint === second
            ? previous
            : { epoch: (previous?.epoch ?? 0) + 1, fingerprint: second };
        dirty = false;
        if (previous && generation !== previous) {
          params.onGenerationChange?.(generation);
        }
        return generation;
      }
    })().finally(() => {
      refresh = undefined;
    });
    return refresh;
  };
  return {
    read: () => generation,
    markDirty,
    wait: () => (dirty ? reconcile() : Promise.resolve(generation)),
    refresh: () => {
      markDirty();
      return reconcile();
    },
    isCurrent: (candidate: CodexDesktopGeneration | undefined) =>
      Boolean(
        candidate &&
        !dirty &&
        generation &&
        candidate.epoch === generation.epoch &&
        candidate.fingerprint === generation.fingerprint,
      ),
    stop: () => {
      stopped = true;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
